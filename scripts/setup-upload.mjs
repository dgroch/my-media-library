// One-time setup for the upload path: add the human-context and dedup
// properties to the Brand Asset Manifest data source. Idempotent — existing
// properties are left untouched (a type mismatch is reported, not changed).
// Run with:  npm run setup:upload
//
// Requires NOTION_TOKEN (and optionally NOTION_ASSETS_DATABASE_ID) in
// .env.local or the environment.

import { readFileSync, existsSync } from "node:fs";
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

const env = { ...loadEnv(ENV_PATH), ...process.env };

const token = env.NOTION_TOKEN;
const assetsDatabaseId =
  env.NOTION_ASSETS_DATABASE_ID || "357fdc24-425f-81ed-805c-c4f9aff0665f";

if (!token) {
  console.error("✗ NOTION_TOKEN is not set. Add it to .env.local first.");
  process.exit(1);
}

// Human-channel + dedup properties (names match src/lib/config.ts humanProps;
// honour the same NOTION_PROP_* overrides).
const UPLOAD_PROPS = {
  [env.NOTION_PROP_CONTEXT || "Context"]: { rich_text: {} },
  [env.NOTION_PROP_PEOPLE || "People"]: { rich_text: {} },
  [env.NOTION_PROP_PRODUCT || "Product"]: { rich_text: {} },
  [env.NOTION_PROP_LOCATION || "Location"]: { rich_text: {} },
  [env.NOTION_PROP_SHOOT || "Shoot"]: { rich_text: {} },
  [env.NOTION_PROP_CREDIT || "Credit"]: { rich_text: {} },
  [env.NOTION_PROP_RIGHTS || "Rights"]: {
    select: {
      options: [
        { name: "internal", color: "green" },
        { name: "licensed", color: "blue" },
        { name: "restricted", color: "red" },
      ],
    },
  },
  [env.NOTION_PROP_RIGHTS_NOTES || "Rights Notes"]: { rich_text: {} },
  [env.NOTION_PROP_TAGS || "Tags"]: { multi_select: {} },
  [env.NOTION_PROP_SOURCE || "Source"]: { select: {} },
  [env.NOTION_PROP_UPLOADED_BY || "Uploaded By"]: { rich_text: {} },
  [env.NOTION_PROP_UPLOADED_AT || "Uploaded At"]: { date: {} },
  [env.NOTION_PROP_SHA256 || "SHA256"]: { rich_text: {} },
  [env.NOTION_PROP_PHASH || "pHash"]: { rich_text: {} },
};

const notion = new Client({ auth: token });

async function main() {
  console.log("→ Resolving assets data source…");
  const db = await notion.databases.retrieve({ database_id: assetsDatabaseId });
  const dataSourceId = db.data_sources?.[0]?.id;
  if (!dataSourceId) {
    throw new Error(`No data source found on database ${assetsDatabaseId}`);
  }
  console.log(`  data source: ${dataSourceId}`);

  const ds = await notion.dataSources.retrieve({
    data_source_id: dataSourceId,
  });
  const existing = ds.properties ?? {};

  const toAdd = {};
  for (const [name, def] of Object.entries(UPLOAD_PROPS)) {
    const current = existing[name];
    if (!current) {
      toAdd[name] = def;
      continue;
    }
    const wantedType = Object.keys(def)[0];
    if (current.type === wantedType) {
      console.log(`  ✓ "${name}" already exists (${current.type})`);
    } else {
      console.warn(
        `  ⚠ "${name}" exists with type "${current.type}" (expected "${wantedType}").` +
          ` Leaving it alone — set NOTION_PROP_* to point at a different property.`,
      );
    }
  }

  if (Object.keys(toAdd).length === 0) {
    console.log("\n✓ Nothing to add. The Manifest is upload-ready.");
    return;
  }

  console.log(`→ Adding ${Object.keys(toAdd).length} properties…`);
  await notion.dataSources.update({
    data_source_id: dataSourceId,
    properties: toAdd,
  });
  for (const name of Object.keys(toAdd)) console.log(`  + ${name}`);
  console.log("\n✓ Manifest is upload-ready. POST /api/assets is good to go.");
}

main().catch((err) => {
  console.error("✗ Setup failed:", err.body ?? err.message ?? err);
  process.exit(1);
});
