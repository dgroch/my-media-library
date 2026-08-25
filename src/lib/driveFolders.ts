import "server-only";

// The Drive folder tree the mirror files into, cached in-process.
//
// Uploads go into the *existing* curated folders (Products/Bouquets, Photos/
// Products/Plants/Hellebore, …) rather than a separate app-owned tree, so the
// mirror has to know what those folders are. The tree is far too large to send
// to a model per upload — `Products` alone paginates past 40 children — so this
// module does the cheap half: fetch it once, keep it, and narrow to a shortlist
// by lexical overlap. `driveRouting.ts` does the semantic half.

import { driveConfig } from "./config";
import { driveListChildFolders } from "./drive";

export interface DriveFolder {
  id: string;
  name: string;
  /** Slash-joined path below the scanned root, e.g. "Products/Bouquets". */
  path: string;
  depth: number;
}

interface FolderTree {
  folders: DriveFolder[];
  fetchedAt: number;
  /** True when the walk stopped early (depth or folder cap), so the tree is partial. */
  truncated: boolean;
}

let cached: FolderTree | null = null;
let inFlight: Promise<FolderTree> | null = null;

/** Run `task` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Walk the folder tree under the configured root, breadth-first so the most
 * useful (shallow) folders survive the cap if the tree is enormous.
 *
 * Each level is fetched concurrently: this is one Drive round-trip per folder,
 * and walking a few hundred of them serially took long enough to be felt in
 * the upload that triggered the refresh.
 */
async function walkTree(): Promise<FolderTree> {
  const root = driveConfig.rootFolderId || driveConfig.folderId;
  const folders: DriveFolder[] = [];
  let truncated = false;

  let frontier: Array<{ id: string; path: string; depth: number }> = [
    { id: root, path: "", depth: 0 },
  ];

  while (frontier.length > 0) {
    if (frontier[0].depth >= driveConfig.maxFolderDepth) {
      truncated = true;
      break;
    }
    const next: typeof frontier = [];
    const levels = await mapLimit(frontier, driveConfig.listConcurrency, async (parent) => {
      try {
        return { parent, children: await driveListChildFolders(parent.id) };
      } catch (err) {
        // A folder we can't list is not fatal — it just isn't a candidate.
        console.error(`[drive-folders] listing ${parent.path || root} failed`, err);
        return { parent, children: [] };
      }
    });

    for (const { parent, children } of levels) {
      if (folders.length >= driveConfig.maxFolders) {
        truncated = true;
        break;
      }
      for (const child of children) {
        const path = parent.path ? `${parent.path}/${child.name}` : child.name;
        folders.push({ id: child.id, name: child.name, path, depth: parent.depth + 1 });
        next.push({ id: child.id, path, depth: parent.depth + 1 });
      }
    }
    if (folders.length >= driveConfig.maxFolders) {
      truncated = true;
      break;
    }
    frontier = next;
  }

  return { folders, fetchedAt: Date.now(), truncated };
}

/**
 * The cached folder tree, refetched once its TTL expires. Concurrent callers
 * share one walk — this is dozens of Drive calls, not one.
 */
export async function driveFolderTree(): Promise<FolderTree> {
  const fresh =
    cached && Date.now() - cached.fetchedAt < driveConfig.folderCacheMs;
  if (fresh) return cached!;
  if (inFlight) return inFlight;

  inFlight = walkTree()
    .then((tree) => {
      cached = tree;
      inFlight = null;
      return tree;
    })
    .catch((err) => {
      inFlight = null;
      // Serving a stale tree beats failing the mirror over a transient error.
      if (cached) return cached;
      throw err;
    });
  return inFlight;
}

// ---------------------------------------------------------------------------
// Shortlisting
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "with", "for", "at", "to",
  "is", "are", "this", "that", "it", "its", "as", "by", "from", "photo",
  "image", "picture", "shot", "background", "featuring", "against",
]);

/**
 * Crude singularisation so "candle" matches a folder called "Candles". The
 * folder taxonomy is overwhelmingly plural ("Bouquets", "Plants", "Vases")
 * while descriptions and product names are usually singular, so without this
 * the most obvious matches are missed.
 */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t))
    .map(stem);
}

/**
 * Narrow the tree to the folders most plausibly right for this asset, so the
 * model ranks a few dozen candidates instead of thousands.
 *
 * Scoring rewards folders whose name words appear in the asset text, weights
 * the explicit product name far above incidental description words, and gives
 * deeper (more specific) folders a small edge over their parents when both
 * match — "Products/Plants/Hellebore" should beat "Products" for a hellebore.
 */
export function shortlistFolders(
  folders: DriveFolder[],
  assetText: string,
  productName: string,
  limit: number,
): DriveFolder[] {
  const assetTokens = new Set(tokenise(assetText));
  const productTokens = new Set(tokenise(productName));

  const scored = folders.map((folder) => {
    const nameTokens = tokenise(folder.name);
    if (nameTokens.length === 0) return { folder, score: 0 };
    let hits = 0;
    for (const token of nameTokens) {
      if (productTokens.has(token)) hits += 10;
      else if (assetTokens.has(token)) hits += 3;
    }
    // No lexical overlap means not a candidate — full stop. The depth nudge
    // below is a tie-breaker between real matches, and must never be able to
    // give an unrelated folder a positive score on its own.
    if (hits === 0) return { folder, score: 0 };
    // Normalise so a long folder name isn't rewarded just for having more
    // words to match on, then prefer the more specific of two matches.
    const score = hits / nameTokens.length + folder.depth * 0.25;
    return { folder, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.folder);
}

/**
 * Candidates to offer the model: lexical matches first, then the shallow
 * folders as a general-purpose backstop, so an asset whose words match nothing
 * still gets the top-level taxonomy to choose from.
 */
export function folderCandidates(
  folders: DriveFolder[],
  assetText: string,
  productName: string,
): DriveFolder[] {
  const limit = driveConfig.maxCandidates;
  // Real libraries contain sibling folders with identical names (this one has
  // two "Marseille Signature" under Products). The model chooses by path, so
  // duplicates would be indistinguishable to it and resolve arbitrarily —
  // collapse them to one, keeping the first, so placement is deterministic.
  const matched = dedupeByPath(shortlistFolders(folders, assetText, productName, limit));
  const seen = new Set(matched.map((f) => f.path.toLowerCase()));
  const shallow = folders
    .filter((f) => f.depth <= 2 && !seen.has(f.path.toLowerCase()))
    .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));

  for (const folder of shallow) {
    if (matched.length >= limit) break;
    matched.push(folder);
    seen.add(folder.path.toLowerCase());
  }
  return matched;
}

function dedupeByPath(folders: DriveFolder[]): DriveFolder[] {
  const seen = new Set<string>();
  return folders.filter((folder) => {
    const key = folder.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
