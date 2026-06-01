import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";

import { ASSET_INDEX_PATH } from "./config";
import { embedQuery } from "./embeddings";
import type { MediaType } from "./media";
import type { Asset, SearchResponse } from "./types";

// The index is produced by `npm run build:index` as two files:
//   - src/data/asset-index.json      (small metadata, one entry per asset)
//   - src/data/asset-index.vec.bin   (contiguous little-endian float32 vectors)
// Storing vectors as one binary blob (rather than JSON number arrays) keeps
// memory tiny and avoids a parse spike — important on a 512MB instance.

interface MetaRecord {
  id: string;
  title: string;
  url: string;
  description: string;
  mediaType: MediaType;
  driveLink: string;
  createdTime: string;
}

interface MetaFile {
  model: string;
  dimensions: number;
  count: number;
  builtAt: string;
  assets: MetaRecord[];
}

interface LoadedIndex {
  dim: number;
  /** All asset vectors concatenated and unit-normalised, length count*dim. */
  vectors: Float32Array;
  assets: Asset[];
  /** createdTime per asset, parallel to `assets`. */
  createdTimes: string[];
  /** Asset indices ordered newest-first, for empty queries. */
  recencyOrder: number[];
}

const MAX_HITS = 300;

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
    const createdTimes = meta.assets.map((a) => a.createdTime);
    const recencyOrder = assets
      .map((_, i) => i)
      .sort((a, b) => createdTimes[b].localeCompare(createdTimes[a]));

    loaded = { dim, vectors, assets, createdTimes, recencyOrder };
    return loaded;
  } catch (err) {
    console.error("failed to load search index", err);
    loaded = null;
    return null;
  }
}

/** True if a usable prebuilt index is present. */
export function hasIndex(): boolean {
  return loadIndex() !== null;
}

export async function semanticSearch(
  query: string,
  offset = 0,
  pageSize = 24,
): Promise<SearchResponse> {
  const index = loadIndex();
  if (!index) throw new Error("Search index not loaded");

  const { dim, vectors, assets, recencyOrder } = index;

  let order: number[];

  if (!query.trim()) {
    order = recencyOrder;
  } else {
    const q = await embedQuery(query);
    // Normalise the query vector.
    let s = 0;
    for (const x of q) s += x * x;
    const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
    const qn = new Float32Array(dim);
    for (let j = 0; j < dim; j++) qn[j] = (q[j] ?? 0) * inv;

    const scored: Array<{ i: number; score: number }> = [];
    for (let i = 0; i < assets.length; i++) {
      const off = i * dim;
      let dotp = 0;
      for (let j = 0; j < dim; j++) dotp += qn[j] * vectors[off + j];
      scored.push({ i, score: dotp });
    }
    scored.sort((a, b) => b.score - a.score);
    order = scored.slice(0, MAX_HITS).map((x) => x.i);
  }

  const page = order.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;
  return {
    results: page.map((i) => assets[i]),
    nextCursor: nextOffset < order.length ? String(nextOffset) : null,
  };
}
