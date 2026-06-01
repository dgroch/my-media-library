// Build the semantic search index:
//   1. Page through every row in the Brand Asset Manifest.
//   2. Concatenate each asset's descriptive fields into one document.
//   3. Embed all documents (OpenAI) and write data/asset-index.json.
//
// Run with:  npm run build:index
// Requires NOTION_TOKEN and OPENAI_API_KEY.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "@notionhq/client";

// --- config (mirrors src/lib/config.ts) ------------------------------------
const ENV_PATH = ".env.local";
const OUT_PATH = process.env.ASSET_INDEX_PATH || "data/asset-index.json";

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
    mediaType,
    createdTime: page.created_time ?? "",
    text: lines.join("\n"),
  };
}

async function embedBatch(inputs) {
  const res = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({ model, input: inputs, dimensions }),
  });
  if (!res.ok) {
    throw new Error(`Embedding request failed (${res.status}): ${await res.text()}`);
  }
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
  const records = pages.map(toRecord);
  console.log(`  ${records.length} assets total`);

  console.log(`→ Embedding (${model}, ${dimensions}d)…`);
  const BATCH = 128;
  const assets = [];
  for (let i = 0; i < records.length; i += BATCH) {
    const slice = records.slice(i, i + BATCH);
    const vectors = await embedBatch(slice.map((r) => r.text));
    slice.forEach((r, j) => {
      const { text, ...rest } = r; // drop the raw text from the index
      assets.push({ ...rest, v: vectors[j] });
    });
    process.stdout.write(`\r  embedded ${assets.length}/${records.length}…`);
  }
  process.stdout.write("\n");

  const out = {
    model,
    dimensions,
    builtAt: new Date().toISOString(),
    assets,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out));
  const mb = (Buffer.byteLength(JSON.stringify(out)) / 1e6).toFixed(1);
  console.log(`✓ Wrote ${assets.length} assets to ${OUT_PATH} (${mb} MB)`);
}

main().catch((err) => {
  console.error("\n✗ Index build failed:", err.body ?? err.message ?? err);
  process.exit(1);
});
