// Build the semantic search index:
//   1. Page through every row in the Brand Asset Manifest.
//   2. Concatenate each asset's descriptive fields into one document.
//   3. Embed all documents (OpenAI) and write data/asset-index.json.
//
// Run with:  npm run build:index
// Requires NOTION_TOKEN and OPENAI_API_KEY.

import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  createWriteStream,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { Client } from "@notionhq/client";

// --- config (mirrors src/lib/config.ts) ------------------------------------
const ENV_PATH = ".env.local";
// Written under src/ so it is bundled into the build via a static import.
const OUT_PATH = process.env.ASSET_INDEX_PATH || "src/data/asset-index.json";

// Human-channel fields (the upload path's metadata, created by
// `npm run setup:upload`). These lead the embedding document — human context
// beats the AI classifier, so "Kellie tying stems" matches even though the
// classifier only saw "florist in black apron".
const HUMAN_TEXT_PROPS = [
  ["Context", "Context"],
  ["Product", "Product"],
  ["Location", "Location"],
  ["Shoot", "Shoot"],
  ["Tags", "Tags"],
];

// AI-channel fields concatenated after the human context, in priority order.
const EMBEDDING_TEXT_PROPS = [
  ["Description", "Overall Description"],
  ["Tags", "Visual Tags"],
  ["Products", "Products / Flowers"],
  ["Product name", "Product Name"],
  ["Content type", "Content Type"],
  ["Mood", "Mood Tone"],
  ["Setting", "Setting / Location"],
  ["People", "People Present"],
  ["Usable for", "Usable For"],
  ["Scene beats", "Timestamp Beats"],
  ["Notes", "Reorg Notes"],
];

const NOTION_QUERY_CAP = 10000;
let globalFetchCount = 0;

// --- tiny .env loader -------------------------------------------------------
function loadEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    )
      val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

const env = { ...loadEnv(ENV_PATH), ...process.env };

const token = env.NOTION_TOKEN;
const openaiKey = env.OPENAI_API_KEY;
const baseUrl = env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const model = env.EMBEDDING_MODEL || "text-embedding-3-small";
const dimensions = Number(env.EMBEDDING_DIMENSIONS || "512");
const notionMaxRetries = Number(env.NOTION_MAX_RETRIES || "6");
const embeddingMaxRetries = Number(env.EMBEDDING_MAX_RETRIES || "8");
const embeddingBatchSize = Number(env.EMBEDDING_BATCH_SIZE || "64");
const embeddingThrottleMs = Number(env.EMBEDDING_THROTTLE_MS || "250");
const assetsDatabaseId =
  env.NOTION_ASSETS_DATABASE_ID || "357fdc24-425f-81ed-805c-c4f9aff0665f";
let assetsDataSourceId = env.NOTION_ASSETS_DATA_SOURCE_ID || "";

if (!token) {
  console.error("✗ NOTION_TOKEN is not set.");
  process.exit(1);
}
if (!openaiKey) {
  console.error("✗ OPENAI_API_KEY is not set.");
  process.exit(1);
}

const notion = new Client({ auth: token });

// --- retry helpers -----------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms) {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function retryAfterMs(headers) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function notionStatus(err) {
  return err?.status || err?.code || err?.body?.status;
}

function isRetriableNotionError(err) {
  const status = notionStatus(err);
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    err?.code === "ECONNRESET" ||
    err?.code === "ETIMEDOUT" ||
    err?.code === "ENOTFOUND"
  );
}

function isRetriableEmbeddingStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function withRetry(label, fn, { maxRetries, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const canRetry = err?.retriable !== false;
      if (!canRetry || attempt === maxRetries) break;
      const delay = jitter(err?.retryAfterMs ?? baseDelayMs * 2 ** attempt);
      process.stdout.write(
        `\n  ${label} failed (${err?.status || err?.code || err?.message}); retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms…`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

// --- property helpers -------------------------------------------------------
function plainText(prop) {
  if (!prop) return "";
  if (prop.type === "title")
    return (prop.title || []).map((t) => t.plain_text ?? "").join("");
  if (prop.type === "rich_text")
    return (prop.rich_text || []).map((t) => t.plain_text ?? "").join("");
  if (prop.type === "url") return prop.url ?? "";
  if (prop.type === "select") return prop.select?.name ?? "";
  if (prop.type === "multi_select")
    return (prop.multi_select || []).map((s) => s.name).join(", ");
  return "";
}

const IMAGE_EXT = new Set([
  "jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "tiff", "bmp",
]);
const VIDEO_EXT = new Set(["mp4", "mov", "webm", "m4v", "avi", "mkv", "gifv"]);

function detectMediaType(filename, mime, assetType) {
  const m = /\.([a-z0-9]+)\s*$/i.exec((filename || "").trim());
  const ext = m ? m[1].toLowerCase() : "";
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  const mm = (mime || "").toLowerCase();
  if (mm.startsWith("image/")) return "image";
  if (mm.startsWith("video/")) return "video";
  const a = (assetType || "").toLowerCase();
  if (a === "image" || a === "video") return a;
  return "other";
}

// --- main -------------------------------------------------------------------
async function resolveDataSource() {
  if (assetsDataSourceId) return assetsDataSourceId;
  const db = await withRetry(
    "notion database retrieve",
    async () => {
      try {
        return await notion.databases.retrieve({ database_id: assetsDatabaseId });
      } catch (err) {
        err.retriable = isRetriableNotionError(err);
        throw err;
      }
    },
    { maxRetries: notionMaxRetries, baseDelayMs: 1000 },
  );
  const id = db.data_sources?.[0]?.id;
  if (!id) throw new Error("No data source found on assets database");
  assetsDataSourceId = id;
  return id;
}

async function queryDataSource(dataSourceId, body) {
  return withRetry(
    "notion data source query",
    async () => {
      try {
        return await notion.dataSources.query({ data_source_id: dataSourceId, ...body });
      } catch (err) {
        err.retriable = isRetriableNotionError(err);
        throw err;
      }
    },
    { maxRetries: notionMaxRetries, baseDelayMs: 1000 },
  );
}

async function fetchAllRows(dataSourceId) {
  const oldest = await edgeCreatedTime(dataSourceId, "ascending");
  const newest = await edgeCreatedTime(dataSourceId, "descending");
  if (!oldest || !newest) return [];

  globalFetchCount = 0;
  const rows = [];
  for (const [start, end] of monthRanges(oldest, newest)) {
    rows.push(...(await fetchRowsInCreatedRange(dataSourceId, start, end)));
  }
  process.stdout.write("\n");
  return rows;
}

async function edgeCreatedTime(dataSourceId, direction) {
  const res = await queryDataSource(dataSourceId, {
    page_size: 1,
    sorts: [{ timestamp: "created_time", direction }],
  });
  return res.results[0]?.created_time;
}

function monthRanges(oldest, newest) {
  const start = new Date(oldest);
  const final = new Date(newest);
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const ranges = [];
  while (cursor <= final) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    ranges.push([cursor.toISOString(), next.toISOString()]);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return ranges;
}

function createdTimeRangeFilter(start, end) {
  return {
    and: [
      { timestamp: "created_time", created_time: { on_or_after: start } },
      { timestamp: "created_time", created_time: { before: end } },
    ],
  };
}

async function fetchRowsInCreatedRange(dataSourceId, start, end, depth = 0) {
  const rows = [];
  let cursor;
  do {
    const res = await queryDataSource(dataSourceId, {
      page_size: 100,
      filter: createdTimeRangeFilter(start, end),
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    rows.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
    process.stdout.write(
      `\r  fetched ${rows.length} rows in ${start.slice(0, 10)}..${end.slice(0, 10)}; total ${globalFetchCount + rows.length}…`,
    );
    if (rows.length >= NOTION_QUERY_CAP && cursor) {
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      if (depth >= 12 || endMs - startMs <= 60 * 60 * 1000) {
        throw new Error(
          `Notion query cap reached for ${start}..${end}; narrow the shard further`,
        );
      }
      const mid = new Date(startMs + (endMs - startMs) / 2).toISOString();
      console.warn(
        `\n⚠ Notion returned ${NOTION_QUERY_CAP} rows for ${start.slice(0, 10)}..${end.slice(0, 10)}; splitting shard.`,
      );
      const left = await fetchRowsInCreatedRange(dataSourceId, start, mid, depth + 1);
      const right = await fetchRowsInCreatedRange(dataSourceId, mid, end, depth + 1);
      return [...left, ...right];
    }
  } while (cursor);
  globalFetchCount += rows.length;
  return rows;
}

// The "People" property stores a JSON array like
// [{"name":"Kellie","consent":true}]; fall back to comma-separated names if
// someone hand-edited it in Notion.
function parsePeopleNames(raw) {
  if (!raw.trim()) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return arr.map((person) => person?.name).filter(Boolean);
    }
  } catch {
    // not JSON — treat as a plain list
  }
  return raw
    .split(/[,;]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function readTags(prop) {
  if (prop?.type === "multi_select") {
    return (prop.multi_select || []).map((s) => s.name).filter(Boolean);
  }
  return plainText(prop)
    .split(/[,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function toRecord(page) {
  const p = page.properties ?? {};
  const title = plainText(p["Asset"]) || "Untitled";
  const description = plainText(p["Overall Description"]);
  const url = plainText(p["Preview URL"]);
  const driveLink = plainText(p["Drive Link"]);
  const driveFileId = plainText(p["Drive File ID"]);
  const mediaType = detectMediaType(
    title,
    plainText(p["Mime Type"]),
    plainText(p["Asset Type"]),
  );

  // Human channel — leads the embedding text and is carried in the metadata
  // for direct keyword boosting (people/product) at query time.
  const context = plainText(p["Context"]);
  const people = parsePeopleNames(plainText(p["People"]));
  const product = plainText(p["Product"]);
  const location = plainText(p["Location"]);
  const tags = readTags(p["Tags"]);
  const phash = plainText(p["pHash"]);

  const lines = [title];
  if (context) lines.push(`Context: ${context}`);
  if (people.length) lines.push(`People: ${people.join(", ")}`);
  for (const [label, name] of HUMAN_TEXT_PROPS) {
    if (name === "Context") continue; // already added first
    const v = name === "Tags" ? tags.join(", ") : plainText(p[name]);
    if (v) lines.push(`${label}: ${v}`);
  }
  for (const [label, name] of EMBEDDING_TEXT_PROPS) {
    const v = plainText(p[name]);
    if (v) lines.push(`${label}: ${v}`);
  }

  return {
    id: page.id,
    title,
    url,
    description,
    driveLink,
    driveFileId,
    mediaType,
    context,
    people,
    product,
    location,
    tags,
    phash,
    createdTime: page.created_time ?? "",
    lastEditedTime: page.last_edited_time ?? "",
    text: lines.join("\n"),
  };
}

function recordScore(record) {
  // Prefer canonical rows that can display in the UI. Preview URL is the most
  // important because the frontend renders <img src={asset.url}> from it.
  let score = 0;
  if (record.url) score += 100;
  if (record.driveLink) score += 10;
  if (record.description) score += 5;
  score += Date.parse(record.lastEditedTime || record.createdTime || "") / 1e13 || 0;
  return score;
}

function dedupeRecords(records) {
  const byKey = new Map();
  const uniqueNoKey = [];

  for (const record of records) {
    const key = record.driveFileId || `page:${record.id}`;
    if (!record.driveFileId) {
      uniqueNoKey.push(record);
      continue;
    }
    const existing = byKey.get(key);
    if (!existing || recordScore(record) > recordScore(existing)) {
      byKey.set(key, record);
    }
  }

  return [...byKey.values(), ...uniqueNoKey];
}

async function embedBatch(inputs) {
  const res = await withRetry(
    "embedding request",
    async () => {
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({ model, input: inputs, dimensions }),
      });
      if (!response.ok) {
        const detail = await response.text();
        const err = new Error(
          `Embedding request failed (${response.status}): ${detail}`,
        );
        err.status = response.status;
        err.retryAfterMs = retryAfterMs(response.headers);
        err.retriable = isRetriableEmbeddingStatus(response.status);
        throw err;
      }
      return response;
    },
    { maxRetries: embeddingMaxRetries, baseDelayMs: 1500 },
  );
  const json = await res.json();
  // Preserve input order regardless of the response ordering.
  return json.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

async function main() {
  console.log("→ Resolving assets data source…");
  const dataSourceId = await resolveDataSource();

  console.log("→ Fetching manifest rows…");
  const pages = await fetchAllRows(dataSourceId);
  const activePages = pages.filter((page) => !page.archived && !page.in_trash);
  const records = dedupeRecords(activePages.map(toRecord));
  console.log(
    `  ${pages.length} rows fetched; ${activePages.length} active; ${records.length} unique assets after Drive File ID dedupe`,
  );

  console.log(`→ Embedding (${model}, ${dimensions}d)…`);
  const BATCH = embeddingBatchSize;
  const VEC_PATH = OUT_PATH.replace(/\.json$/, "") + ".vec.bin";
  mkdirSync(dirname(OUT_PATH), { recursive: true });

  // Stream vectors to a binary file (little-endian float32) so we never hold
  // the whole embedding matrix in memory — keeps the build well under 512MB.
  const vecStream = createWriteStream(VEC_PATH);
  const meta = [];
  let done = 0;

  for (let i = 0; i < records.length; i += BATCH) {
    const slice = records.slice(i, i + BATCH);
    const vectors = await embedBatch(slice.map((r) => r.text));
    slice.forEach((r, j) => {
      const vec = Float32Array.from(vectors[j]);
      if (!vecStream.write(Buffer.from(vec.buffer))) {
        // Backpressure handled lazily; for our sizes this is fine.
      }
      const { text, ...rest } = r; // metadata only — no vector in the JSON
      // Drop empty human-channel fields so the meta file doesn't bloat for
      // the (initially vast) majority of rows without them.
      for (const key of ["context", "people", "product", "location", "tags", "phash"]) {
        const v = rest[key];
        if (v === "" || (Array.isArray(v) && v.length === 0)) delete rest[key];
      }
      meta.push(rest);
    });
    done += slice.length;
    process.stdout.write(`\r  embedded ${done}/${records.length}…`);
    if (embeddingThrottleMs > 0 && done < records.length) {
      await sleep(embeddingThrottleMs);
    }
  }
  process.stdout.write("\n");

  await new Promise((resolve, reject) => {
    vecStream.on("finish", resolve);
    vecStream.on("error", reject);
    vecStream.end();
  });

  const metaOut = {
    model,
    dimensions,
    count: meta.length,
    builtAt: new Date().toISOString(),
    assets: meta,
  };
  writeFileSync(OUT_PATH, JSON.stringify(metaOut));

  const metaMb = (Buffer.byteLength(JSON.stringify(metaOut)) / 1e6).toFixed(1);
  const vecMb = (statSync(VEC_PATH).size / 1e6).toFixed(1);
  console.log(
    `✓ Wrote ${meta.length} assets — meta ${OUT_PATH} (${metaMb} MB), vectors ${VEC_PATH} (${vecMb} MB)`,
  );
}

main().catch((err) => {
  console.error("\n✗ Index build failed:", err.body ?? err.message ?? err);
  process.exit(1);
});
