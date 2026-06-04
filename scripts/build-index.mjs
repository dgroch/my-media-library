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

// Fields concatenated into the embedding document, in priority order.
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
  const db = await notion.databases.retrieve({ database_id: assetsDatabaseId });
  const id = db.data_sources?.[0]?.id;
  if (!id) throw new Error("No data source found on assets database");
  assetsDataSourceId = id;
  return id;
}

async function fetchAllRows(dataSourceId) {
  const rows = [];
  let cursor;
  do {
    const res = await notion.dataSources.query({
      data_source_id: dataSourceId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    rows.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
    process.stdout.write(`\r  fetched ${rows.length} rows…`);
  } while (cursor);
  process.stdout.write("\n");
  return rows;
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

  const lines = [title];
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How long to wait before retrying a rate-limited / transient failure. Prefer
// the server's own guidance (Retry-After header, or OpenAI's "try again in Xs"
// hint in the body), then fall back to exponential backoff with jitter.
function retryDelayMs(res, body, attempt) {
  const header = res.headers.get("retry-after");
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return Math.max(secs * 1000, 1000);
  }
  const hint = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(body || "");
  if (hint) {
    const v = Number(hint[1]);
    const ms = hint[2].toLowerCase() === "ms" ? v : v * 1000;
    if (Number.isFinite(ms)) return Math.max(ms + 250, 1000); // small cushion
  }
  // 2s, 4s, 8s, … capped at 30s, plus jitter to avoid thundering-herd retries.
  return Math.min(2000 * 2 ** attempt, 30000) + Math.floor(Math.random() * 500);
}

const MAX_EMBED_RETRIES = Number(env.EMBED_MAX_RETRIES || "8");

async function embedBatch(inputs) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({ model, input: inputs, dimensions }),
    });

    if (res.ok) {
      const json = await res.json();
      // Preserve input order regardless of the response ordering.
      return json.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    }

    const body = await res.text();
    // 429 (rate limit) and 5xx (transient server errors) are worth retrying;
    // 4xx like 400/401 are not — fail fast on those.
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_EMBED_RETRIES) {
      throw new Error(`Embedding request failed (${res.status}): ${body}`);
    }

    const delay = retryDelayMs(res, body, attempt);
    process.stdout.write(
      `\r  ${res.status} from embeddings; retry ${attempt + 1}/${MAX_EMBED_RETRIES} in ${(delay / 1000).toFixed(1)}s…          `,
    );
    await sleep(delay);
  }
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
  const BATCH = 128;
  // Pace batches to stay under OpenAI's tokens-per-minute limit. A full 128-row
  // batch is ~1s of budget against the 1M TPM tier, so ~1.1s between batches
  // keeps us safely under it; override with EMBED_PACE_MS if your tier differs.
  const PACE_MS = Number(env.EMBED_PACE_MS || "1100");
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
      meta.push(rest);
    });
    done += slice.length;
    process.stdout.write(`\r  embedded ${done}/${records.length}…          `);
    if (PACE_MS > 0 && i + BATCH < records.length) await sleep(PACE_MS);
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
