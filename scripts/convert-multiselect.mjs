// One-time maintenance: convert the AI-channel tag properties on the Brand
// Asset Manifest from `multi_select` to `rich_text`.
//
// Why: every distinct tag value the manifesting pipeline writes becomes a
// permanent multi_select *option* on the schema. With thousands of assets the
// option lists grow huge, which makes `dataSources.retrieve` (the schema read
// every upload depends on) slow enough to hit the Notion client's timeout.
// Converting to rich_text drops the option machinery entirely — Notion keeps
// each page's values as plain comma-separated text — and the app already
// treats these fields as text (see `embeddingTextProps` in src/lib/config.ts),
// so keyword search actually gains coverage from the change.
//
// Idempotent and safe to re-run: properties already rich_text are skipped.
// Dry-run by default; pass --yes to apply.
//
//   npm run convert:multiselect          # show the plan
//   npm run convert:multiselect -- --yes # apply it
//
// Requires NOTION_TOKEN (and optionally NOTION_ASSETS_DATABASE_ID) in
// .env.local or the environment — same as setup:upload.

import { readFileSync, existsSync } from "node:fs";
import { Client } from "@notionhq/client";

const ENV_PATH = ".env.local";

// --- tiny .env loader --------------------------------------------------------
function loadEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const env = { ...loadEnv(ENV_PATH), ...process.env };
const token = env.NOTION_TOKEN;
if (!token) {
  console.error("✗ NOTION_TOKEN is not set (in .env.local or the environment).");
  process.exit(1);
}
const assetsDatabaseId =
  env.NOTION_ASSETS_DATABASE_ID || "357fdc24-425f-81ed-805c-c4f9aff0665f";

// The tag-list properties the manifesting pipeline writes. Names track the
// app's config (override via the same env vars).
const TARGETS = [
  env.NOTION_PROP_VISUAL_TAGS || "Visual Tags",
  env.NOTION_PROP_PRODUCTS_FLOWERS || "Products / Flowers",
  env.NOTION_PROP_MOOD_TONE || "Mood Tone",
  env.NOTION_PROP_USABLE_FOR || "Usable For",
];

const apply = process.argv.includes("--yes");
// Schema reads on this database can be slow (that's the point of this script);
// give the client a generous timeout.
const notion = new Client({ auth: token, timeoutMs: 180000 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(label, fn, maxRetries = 4) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const code = err?.code || err?.status;
      const retriable =
        code === "notionhq_client_request_timeout" ||
        code === 429 ||
        (typeof code === "number" && code >= 500);
      if (!retriable || attempt === maxRetries) break;
      const delay = Math.min(2000 * 2 ** attempt, 15000);
      console.warn(`  ${label} failed (${code}); retry in ${delay / 1000}s…`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function main() {
  console.log("→ Resolving data source…");
  const db = await withRetry("database retrieve", () =>
    notion.databases.retrieve({ database_id: assetsDatabaseId }),
  );
  const dataSourceId = db.data_sources?.[0]?.id;
  if (!dataSourceId) throw new Error("No data source found on the assets database.");

  console.log("→ Reading schema (this is the slow call we're here to fix)…");
  const ds = await withRetry("data source retrieve", () =>
    notion.dataSources.retrieve({ data_source_id: dataSourceId }),
  );
  const props = ds.properties ?? {};

  const plan = [];
  for (const name of TARGETS) {
    const prop = props[name];
    if (!prop) {
      console.log(`  · "${name}" — not on the schema, skipping.`);
      continue;
    }
    const optionCount = prop.multi_select?.options?.length;
    if (prop.type === "rich_text") {
      console.log(`  ✓ "${name}" — already rich_text.`);
      continue;
    }
    if (prop.type !== "multi_select") {
      console.log(`  ⚠ "${name}" — is ${prop.type}; only multi_select is converted. Skipping.`);
      continue;
    }
    console.log(`  → "${name}" — multi_select with ${optionCount ?? "?"} options → rich_text`);
    plan.push(name);
  }

  if (plan.length === 0) {
    console.log("\n✓ Nothing to convert.");
    return;
  }

  if (!apply) {
    console.log(
      `\nDry run: would convert ${plan.length} propert${plan.length === 1 ? "y" : "ies"}. ` +
        "Notion preserves existing values as comma-separated text. " +
        "Re-run with --yes to apply.",
    );
    return;
  }

  // Convert one property per request so a failure leaves a clear state.
  for (const name of plan) {
    console.log(`→ Converting "${name}"…`);
    await withRetry(`update ${name}`, () =>
      notion.dataSources.update({
        data_source_id: dataSourceId,
        properties: { [name]: { type: "rich_text", rich_text: {} } },
      }),
    );
    console.log(`  ✓ "${name}" is now rich_text.`);
  }

  console.log(
    "\n✓ Done. The schema retrieve should now be fast. Restart/redeploy the web\n" +
      "  service (or just wait — the cache re-warms on next boot), and consider a\n" +
      "  reindex so search picks the fields up as text: npm run reindex.",
  );
}

main().catch((err) => {
  console.error("\n✗ Conversion failed:", err?.message || err);
  process.exit(1);
});
