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

/** Fraction of query terms found in the asset's text — fallback scoring for
 *  overlay entries that have no embedding yet. */
function termMatchScore(terms: string[], haystackLower: string): number {
  if (!terms.length) return 0;
  let hits = 0;
  for (const term of terms) {
    if (haystackLower.includes(term)) hits++;
  }
  return (hits / terms.length) * 0.4;
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
        if (!runtime.has(index.assets[i].id)) ordered.push(index.assets[i]);
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
        if (runtime.has(assets[i].id)) continue; // shadowed by overlay
        const off = i * dim;
        let dotp = 0;
        for (let j = 0; j < dim; j++) dotp += qn[j] * vectors[off + j];
        scored.push({
          asset: assets[i],
          score: dotp + keywordBoost(queryLower, human[i]),
        });
      }
    }

    for (const entry of overlayEntries) {
      let score = keywordBoost(queryLower, entry.human);
      if (entry.vector && qn && entry.vector.length === qn.length) {
        let dotp = 0;
        for (let j = 0; j < qn.length; j++) dotp += qn[j] * entry.vector[j];
        score += dotp;
      } else {
        // No embedding (yet) — fall back to plain term matching over the
        // asset's text so a fresh upload is still findable by its context.
        const haystack = [
          entry.asset.title,
          entry.asset.description,
          entry.human.context,
          entry.human.people.join(" "),
          entry.human.product,
          entry.human.location,
          entry.human.tags.join(" "),
        ]
          .join(" ")
          .toLowerCase();
        score += termMatchScore(terms, haystack);
        if (score <= 0) continue; // no signal at all — leave it out
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
