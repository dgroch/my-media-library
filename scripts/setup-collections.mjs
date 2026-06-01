// One-time setup: create the "Collections" database in Notion and write its id
// into .env.local. Run with:  npm run setup:collections
//
// Requires NOTION_TOKEN and (optionally) NOTION_ASSETS_DATABASE_ID and
// NOTION_COLLECTIONS_PARENT_PAGE_ID to be set in .env.local.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Client } from "@notionhq/client";

const ENV_PATH = ".env.local";

// --- tiny .env loader (so this standalone script sees .env.local) -----------
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

const fileEnv = loadEnv(ENV_PATH);
const env = { ...fileEnv, ...process.env };

const token = env.NOTION_TOKEN;
const assetsDatabaseId =
  env.NOTION_ASSETS_DATABASE_ID || "357fdc24-425f-81ed-805c-c4f9aff0665f";
const parentPageId =
  env.NOTION_COLLECTIONS_PARENT_PAGE_ID ||
  "352fdc24-425f-8088-930c-c5c1ff6afa95";

if (!token) {
  console.error("✗ NOTION_TOKEN is not set. Add it to .env.local first.");
  process.exit(1);
}

const notion = new Client({ auth: token });

async function main() {
  // 1. Resolve the assets data source so we can point a relation at it.
  console.log("→ Resolving assets data source…");
  const assetsDb = await notion.databases.retrieve({
    database_id: assetsDatabaseId,
  });
  const assetsDataSourceId = assetsDb.data_sources?.[0]?.id;
  if (!assetsDataSourceId) {
    throw new Error(`No data source found on database ${assetsDatabaseId}`);
  }
  console.log(`  assets data source: ${assetsDataSourceId}`);

  // 2. Create the Collections database under the parent page.
  console.log("→ Creating Collections database…");
  const db = await notion.databases.create({
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: "Asset Collections" } }],
    initial_data_source: {
      properties: {
        Name: { title: {} },
        Assets: {
          relation: {
            data_source_id: assetsDataSourceId,
            type: "single_property",
            single_property: {},
          },
        },
      },
    },
  });

  const databaseId = db.id;
  const dataSourceId = db.data_sources?.[0]?.id ?? "";
  console.log(`  ✓ created database: ${databaseId}`);
  console.log(`  ✓ data source:      ${dataSourceId}`);

  // 3. Persist into .env.local.
  upsertEnv(ENV_PATH, {
    NOTION_COLLECTIONS_DATABASE_ID: databaseId,
    NOTION_COLLECTIONS_DATA_SOURCE_ID: dataSourceId,
  });
  console.log(`\n✓ Wrote NOTION_COLLECTIONS_* to ${ENV_PATH}. You're ready to go.`);
}

function upsertEnv(path, updates) {
  let lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  writeFileSync(path, lines.join("\n"));
}

main().catch((err) => {
  console.error("✗ Setup failed:", err.body ?? err.message ?? err);
  process.exit(1);
});
