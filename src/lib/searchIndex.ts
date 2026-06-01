import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { ASSET_INDEX_PATH } from "./config";
import { embedQuery } from "./embeddings";
import type { MediaType } from "./media";
import type { Asset, SearchResponse } from "./types";

// Shape persisted by scripts/build-index.mjs
interface IndexRecord {
  id: string;
  title: string;
  url: string;
  description: string;
  mediaType: MediaType;
  driveLink: string;
  createdTime: string;
  v: number[];
}

interface IndexFile {
  model: string;
  dimensions: number;
  builtAt: string;
  assets: IndexRecord[];
}

interface LoadedRecord {
  asset: Asset;
  createdTime: string;
  /** Unit-normalised embedding for fast cosine via dot product. */
  vec: Float32Array;
}

interface LoadedIndex {
  records: LoadedRecord[];
  /** Records ordered newest-first, for empty queries. */
  byRecency: LoadedRecord[];
}

// Cap on how many ranked hits we expose per query (the long tail is noise).
const MAX_HITS = 300;

let cache: Promise<LoadedIndex | null> | null = null;

function normalise(v: number[]): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const inv = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

async function loadIndex(): Promise<LoadedIndex | null> {
  const file = path.isAbsolute(ASSET_INDEX_PATH)
    ? ASSET_INDEX_PATH
    : path.join(process.cwd(), ASSET_INDEX_PATH);

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    // No index present — caller falls back to keyword search.
    return null;
  }

  const parsed = JSON.parse(raw) as IndexFile;
  const records: LoadedRecord[] = parsed.assets.map((r) => ({
    asset: {
      id: r.id,
      title: r.title,
      url: r.url,
      description: r.description,
      mediaType: r.mediaType,
      driveLink: r.driveLink,
    },
    createdTime: r.createdTime,
    vec: normalise(r.v),
  }));

  const byRecency = [...records].sort((a, b) =>
    b.createdTime.localeCompare(a.createdTime),
  );

  return { records, byRecency };
}

/** True if a prebuilt index file is available. */
export async function hasIndex(): Promise<boolean> {
  if (!cache) cache = loadIndex();
  return (await cache) !== null;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export async function semanticSearch(
  query: string,
  offset = 0,
  pageSize = 24,
): Promise<SearchResponse> {
  if (!cache) cache = loadIndex();
  const index = await cache;
  if (!index) {
    throw new Error("Search index not loaded");
  }

  let ranked: LoadedRecord[];

  if (!query.trim()) {
    // No query → most recent assets first.
    ranked = index.byRecency;
  } else {
    const qvecRaw = await embedQuery(query);
    const qvec = normalise(qvecRaw);
    ranked = index.records
      .map((r) => ({ r, score: dot(qvec, r.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_HITS)
      .map((x) => x.r);
  }

  const page = ranked.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;
  return {
    results: page.map((r) => r.asset),
    nextCursor: nextOffset < ranked.length ? String(nextOffset) : null,
  };
}
