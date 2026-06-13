import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";

import type { ManifestEntry } from "./assets";
import { ASSET_INDEX_PATH } from "./config";
import { embedQuery } from "./embeddings";
import type { MediaType } from "./media";
import type { Asset, SearchResponse } from "./types";

// The index is produced by `npm run build:index` as two files:
//   - src/data/asset-index.json      (small metadata, one entry per asset)
//   - src/data/asset-index.vec.bin   (contiguous little-endian float32 vectors)
// Storing vectors as one binary blob (rather than JSON number arrays) keeps
// memory tiny and avoids a parse spike — important on a 512MB instance.
//
// On top of the prebuilt index sits a runtime overlay: assets uploaded (or
// PATCHed) through /api/assets are embedded on the spot and inserted here, so
// they are searchable within seconds instead of waiting for the nightly
// re-index. The overlay shadows the base index by asset id and survives until
// the process restarts — by which point the cron job has folded the rows into
// the prebuilt index.

interface MetaRecord {
  id: string;
  title: string;
  url: string;
  description: string;
  mediaType: MediaType;
  driveLink: string;
  createdTime: string;
  // Human-context fields (present once build-index has seen uploaded rows).
  context?: string;
  people?: string[];
  product?: string;
  location?: string;
  source?: string;
  tags?: string[];
  phash?: string;
}

interface MetaFile {
  model: string;
  dimensions: number;
  count: number;
  builtAt: string;
  assets: MetaRecord[];
}

/** Human-channel fields used for direct keyword boosting at query time. */
interface HumanMeta {
  context: string;
  people: string[];
  product: string;
  location: string;
  source: string;
  tags: string[];
}

interface LoadedIndex {
  dim: number;
  /** All asset vectors concatenated and unit-normalised, length count*dim. */
  vectors: Float32Array;
  assets: Asset[];
  human: HumanMeta[];
  phashes: string[];
  ids: Set<string>;
  /** createdTime per asset, parallel to `assets`. */
  createdTimes: string[];
  /** Asset indices ordered newest-first, for empty queries. */
  recencyOrder: number[];
}

interface RuntimeEntry {
  asset: Asset;
  human: HumanMeta;
  phash: string;
  createdTime: string;
  /** Unit-normalised embedding, or null when embedding failed at upload. */
  vector: Float32Array | null;
}

const MAX_HITS = 300;

const runtime = new Map<string, RuntimeEntry>();

// Tombstones: assets archived/deleted at runtime. semanticSearch and
// isSearchable exclude these so a delete is reflected immediately, even for
// rows baked into the prebuilt index (which can't be mutated in place). Cleared
// on restart, by which point the nightly re-index has dropped the archived row.
const removed = new Set<string>();

/** Drop an asset from the runtime overlay and tombstone it out of search. */
export function removeRuntimeAsset(id: string): void {
  runtime.delete(id);
  removed.add(id);
}

let loaded: LoadedIndex | null | undefined;

function resolve(p: string): string {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function loadIndex(): LoadedIndex | null {
  if (loaded !== undefined) return loaded;

  try {
    const metaPath = resolve(ASSET_INDEX_PATH);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as MetaFile;
    if (!meta.assets?.length || !meta.dimensions) {
      loaded = null;
      return null;
    }

    const binPath = metaPath.replace(/\.json$/, "") + ".vec.bin";
    const buf = readFileSync(binPath);
    const vectors = new Float32Array(
      buf.buffer,
      buf.byteOffset,
      Math.floor(buf.byteLength / 4),
    );

    const dim = meta.dimensions;
    const count = meta.assets.length;
    if (vectors.length < count * dim) {
      console.error("index vector file is smaller than expected");
      loaded = null;
      return null;
    }

    // Unit-normalise each vector in place so search is a plain dot product.
    for (let i = 0; i < count; i++) {
      const off = i * dim;
      let s = 0;
      for (let j = 0; j < dim; j++) {
        const x = vectors[off + j];
        s += x * x;
      }
      const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
      for (let j = 0; j < dim; j++) vectors[off + j] *= inv;
    }

    const assets: Asset[] = meta.assets.map((a) => ({
      id: a.id,
      title: a.title,
      url: a.url,
      description: a.description,
      mediaType: a.mediaType,
      driveLink: a.driveLink,
    }));
    const human: HumanMeta[] = meta.assets.map((a) => ({
      context: a.context ?? "",
      people: a.people ?? [],
      product: a.product ?? "",
      location: a.location ?? "",
      source: a.source ?? "",
      tags: a.tags ?? [],
    }));
    const phashes = meta.assets.map((a) => a.phash ?? "");
    const ids = new Set(assets.map((a) => a.id));
    const createdTimes = meta.assets.map((a) => a.createdTime);
    const recencyOrder = assets
      .map((_, i) => i)
      .sort((a, b) => createdTimes[b].localeCompare(createdTimes[a]));

    loaded = {
      dim,
      vectors,
      assets,
      human,
      phashes,
      ids,
      createdTimes,
      recencyOrder,
    };
    return loaded;
  } catch (err) {
    console.error("failed to load search index", err);
    loaded = null;
    return null;
  }
}

/** True if a usable prebuilt index — or any runtime-indexed upload — is present. */
export function hasIndex(): boolean {
  return loadIndex() !== null || runtime.size > 0;
}

// ---------------------------------------------------------------------------
// Runtime overlay (the upload path)
// ---------------------------------------------------------------------------

function humanMetaOf(entry: ManifestEntry): HumanMeta {
  return {
    context: entry.context,
    people: entry.people.map((p) => p.name).filter(Boolean),
    product: entry.product,
    location: entry.location,
    source: entry.source,
    tags: entry.tags,
  };
}

/**
 * Insert or refresh a freshly uploaded/PATCHed asset in the in-memory index.
 * `vector` is the raw embedding of its (human-context-first) text, or null
 * when embedding failed — the asset is then still findable by direct keyword
 * match on its human fields until the next re-index.
 */
export function upsertRuntimeAsset(
  entry: ManifestEntry,
  vector: number[] | null,
): void {
  let vec: Float32Array | null = null;
  if (vector?.length) {
    vec = new Float32Array(vector.length);
    let s = 0;
    for (const x of vector) s += x * x;
    const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
    for (let j = 0; j < vector.length; j++) vec[j] = vector[j] * inv;
  }
  const prev = runtime.get(entry.id);
  runtime.set(entry.id, {
    asset: {
      id: entry.id,
      title: entry.title,
      url: entry.url,
      description: entry.description,
      mediaType: entry.mediaType,
      driveLink: entry.driveLink,
    },
    human: humanMetaOf(entry),
    phash: entry.phash || prev?.phash || "",
    createdTime: prev?.createdTime ?? new Date().toISOString(),
    vector: vec ?? prev?.vector ?? null,
  });
}

/** True when the asset is currently findable through /api/search. */
export function isSearchable(id: string): boolean {
  if (removed.has(id)) return false;
  if (runtime.has(id)) return true;
  return loadIndex()?.ids.has(id) ?? false;
}

/** Every known pHash (prebuilt index + runtime overlay) for near-dup checks. */
export function knownPhashCandidates(): Array<{
  id: string;
  url: string;
  phash: string;
}> {
  const out: Array<{ id: string; url: string; phash: string }> = [];
  const index = loadIndex();
  if (index) {
    for (let i = 0; i < index.assets.length; i++) {
      if (index.phashes[i] && !runtime.has(index.assets[i].id)) {
        out.push({
          id: index.assets[i].id,
          url: index.assets[i].url,
          phash: index.phashes[i],
        });
      }
    }
  }
  for (const entry of runtime.values()) {
    if (entry.phash) {
      out.push({ id: entry.asset.id, url: entry.asset.url, phash: entry.phash });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Direct keyword boost for the human channel: a query that names a person or
 * product should rank those assets up front, not just via embedding
 * similarity (cosine scores live in roughly the same 0–0.6 band, so these
 * additive boosts are decisive on a hit).
 */
function keywordBoost(queryLower: string, human: HumanMeta): number {
  let boost = 0;
  for (const name of human.people) {
    if (name && queryLower.includes(name.toLowerCase())) {
      boost += 0.2;
      break;
    }
  }
  if (human.product && queryLower.includes(human.product.toLowerCase())) {
    boost += 0.15;
  }
  return boost;
}

/** The full searchable text of an asset — title, AI description, and every
 *  editable human field (so a value typed into any field is findable). */
function searchHaystack(asset: Asset, human: HumanMeta): string {
  return [
    asset.title,
    asset.description,
    human.context,
    human.people.join(" "),
    human.product,
    human.location,
    human.source,
    human.tags.join(" "),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

/**
 * Decisive boost when the query (or its terms) appear verbatim anywhere in the
 * asset's text — the "search what I typed" guarantee. A full-phrase hit scores
 * 0.5 (cosine scores live in ~0–0.6, so an exact match ranks up front);
 * otherwise it's the fraction of matched terms. Works for embedded and
 * not-yet-embedded entries alike.
 */
function directHitBoost(
  queryLower: string,
  terms: string[],
  haystack: string,
): number {
  if (!queryLower || !haystack) return 0;
  if (queryLower.length >= 2 && haystack.includes(queryLower)) return 0.5;
  if (terms.length === 0) return 0;
  let hits = 0;
  for (const term of terms) if (term.length >= 2 && haystack.includes(term)) hits++;
  return (hits / terms.length) * 0.45;
}

export async function semanticSearch(
  query: string,
  offset = 0,
  pageSize = 24,
): Promise<SearchResponse> {
  const index = loadIndex();
  if (!index && runtime.size === 0) throw new Error("Search index not loaded");

  const overlayEntries = [...runtime.values()].sort((a, b) =>
    b.createdTime.localeCompare(a.createdTime),
  );

  let ordered: Asset[];

  if (!query.trim()) {
    // Newest first: runtime uploads are by definition the newest rows.
    ordered = overlayEntries.map((e) => e.asset);
    if (index) {
      for (const i of index.recencyOrder) {
        const id = index.assets[i].id;
        if (!runtime.has(id) && !removed.has(id)) ordered.push(index.assets[i]);
      }
    }
  } else {
    const queryLower = query.toLowerCase();
    const terms = queryLower.split(/\s+/).filter(Boolean);

    let qn: Float32Array | null = null;
    if (index || overlayEntries.some((e) => e.vector)) {
      const q = await embedQuery(query);
      let s = 0;
      for (const x of q) s += x * x;
      const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
      qn = new Float32Array(q.length);
      for (let j = 0; j < q.length; j++) qn[j] = (q[j] ?? 0) * inv;
    }

    const scored: Array<{ asset: Asset; score: number }> = [];

    if (index && qn) {
      const { dim, vectors, assets, human } = index;
      for (let i = 0; i < assets.length; i++) {
        // Skip overlay-shadowed and tombstoned (deleted) assets.
        if (runtime.has(assets[i].id) || removed.has(assets[i].id)) continue;
        const off = i * dim;
        let dotp = 0;
        for (let j = 0; j < dim; j++) dotp += qn[j] * vectors[off + j];
        scored.push({
          asset: assets[i],
          score:
            dotp +
            keywordBoost(queryLower, human[i]) +
            directHitBoost(queryLower, terms, searchHaystack(assets[i], human[i])),
        });
      }
    }

    for (const entry of overlayEntries) {
      const haystack = searchHaystack(entry.asset, entry.human);
      let score =
        keywordBoost(queryLower, entry.human) +
        directHitBoost(queryLower, terms, haystack);
      if (entry.vector && qn && entry.vector.length === qn.length) {
        let dotp = 0;
        for (let j = 0; j < qn.length; j++) dotp += qn[j] * entry.vector[j];
        score += dotp;
      } else if (score <= 0) {
        // No embedding yet and no keyword/term signal — leave it out.
        continue;
      }
      scored.push({ asset: entry.asset, score });
    }

    scored.sort((a, b) => b.score - a.score);
    ordered = scored.slice(0, MAX_HITS).map((x) => x.asset);
  }

  const page = ordered.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;
  return {
    results: page,
    nextCursor: nextOffset < ordered.length ? String(nextOffset) : null,
  };
}
