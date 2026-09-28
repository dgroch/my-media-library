// One-time setup for smart (rule-based) collections: add the `Type` and
// `Criteria` properties to the existing Asset Collections data source.
// Idempotent — existing properties are left untouched (a type mismatch is
// reported, not changed). Run with:
//
//   npm run setup:smart-collections            # apply
//   npm run setup:smart-collections -- --dry-run   # show the plan only
//
// Requires NOTION_TOKEN and either NOTION_COLLECTIONS_DATA_SOURCE_ID or
// NOTION_COLLECTIONS_DATABASE_ID in .env.local or the environment.
//
// This NEVER touches the existing `Name` (title) or `Assets` (relation)
// properties, so every manual collection keeps working unchanged.

import { existsSync, readFileSync } from "node:fs";
import { Client } from "@notionhq/client";

const ENV_PATH = ".env.local";
const DRY_RUN = process.argv.includes("--dry-run");

// --- tiny .env loader (matches the other setup scripts) ---------------------
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
  console.error("✗ NOTION_TOKEN is not set. Add it to .env.local first.");
  process.exit(1);
}

// Property names must stay in sync with src/lib/config.ts
// (COLLECTION_TYPE_PROP / COLLECTION_CRITERIA_PROP / COLLECTION_SUMMARY_PROP).
const TYPE_PROP = env.NOTION_PROP_COLLECTION_TYPE || "Type";
const CRITERIA_PROP = env.NOTION_PROP_COLLECTION_CRITERIA || "Criteria";
const SUMMARY_PROP = env.NOTION_PROP_COLLECTION_SUMMARY || "Rule Summary";

// `Type` distinguishes a hand-picked collection (the existing behaviour) from a
// rule-driven one, so listCollections can badge them differently.
// `Criteria` holds the rule as JSON — rich_text is the only Notion property
// that can carry an arbitrary document.
// `Rule Summary` is a human-readable rendering of the same rule, purely so the
// rule is legible when browsing the database inside Notion itself.
const SMART_PROPS = {
  [TYPE_PROP]: {
    select: {
      options: [
        { name: "manual", color: "gray" },
        { name: "smart", color: "purple" },
      ],
    },
  },
  [CRITERIA_PROP]: { rich_text: {} },
  [SUMMARY_PROP]: { rich_text: {} },
};

const notion = new Client({ auth: token });

/** Resolve the collections data source id from either env var. */
async function resolveDataSourceId() {
  const explicit = env.NOTION_COLLECTIONS_DATA_SOURCE_ID;
  if (explicit) {
    console.log(`→ Using NOTION_COLLECTIONS_DATA_SOURCE_ID: ${explicit}`);
    return explicit;
  }

  const databaseId = env.NOTION_COLLECTIONS_DATABASE_ID;
  if (!databaseId) {
    throw new Error(
      "Set NOTION_COLLECTIONS_DATA_SOURCE_ID or NOTION_COLLECTIONS_DATABASE_ID " +
        "in .env.local (run `npm run setup:collections` first if the " +
        "Collections database does not exist yet).",
    );
  }

  console.log(`→ Resolving data source from database ${databaseId}…`);
  const db = await notion.databases.retrieve({ database_id: databaseId });
  const dataSourceId = db.data_sources?.[0]?.id;
  if (!dataSourceId) {
    throw new Error(`No data source found on database ${databaseId}`);
  }
  console.log(`  data source: ${dataSourceId}`);
  return dataSourceId;
}

async function main() {
  const dataSourceId = await resolveDataSourceId();

  const ds = await notion.dataSources.retrieve({
    data_source_id: dataSourceId,
  });
  const existing = ds.properties ?? {};

  // Never add to (or clobber) the two properties the existing app depends on.
  for (const required of ["Name", "Assets"]) {
    if (!existing[required]) {
      console.warn(
        `  ⚠ "${required}" is missing from this data source — is this really ` +
          `the Asset Collections database?`,
      );
    }
  }

  const toAdd = {};
  const toPatch = {};

  for (const [name, def] of Object.entries(SMART_PROPS)) {
    const current = existing[name];
    const wantedType = Object.keys(def)[0];

    if (!current) {
      toAdd[name] = def;
      continue;
    }
    if (current.type !== wantedType) {
      console.warn(
        `  ⚠ "${name}" exists with type "${current.type}" (expected ` +
          `"${wantedType}"). Leaving it alone — point NOTION_PROP_COLLECTION_* ` +
          `at a different property instead.`,
      );
      continue;
    }

    // Same type: check whether the select options are all present. Notion's
    // data source update is additive for options, so we only send what is
    // missing rather than replacing the list.
    if (wantedType === "select") {
      const have = new Set(
        (current.select?.options ?? []).map((o) => o.name),
      );
      const missing = (def.select.options ?? []).filter(
        (o) => !have.has(o.name),
      );
      if (missing.length > 0) {
        toPatch[name] = { select: { options: missing } };
        continue;
      }
    }
    console.log(`  ✓ "${name}" already exists (${current.type})`);
  }

  if (Object.keys(toAdd).length === 0 && Object.keys(toPatch).length === 0) {
    console.log("\n✓ Nothing to do. Smart collections are already configured.");
    return;
  }

  if (Object.keys(toAdd).length > 0) {
    console.log(`\n→ Will ADD ${Object.keys(toAdd).length} propert(ies):`);
    for (const [name, def] of Object.entries(toAdd)) {
      console.log(`   + ${name} (${Object.keys(def)[0]})`);
    }
  }
  if (Object.keys(toPatch).length > 0) {
    console.log(`→ Will ADD missing select options to ${Object.keys(toPatch).length} propert(ies):`);
    for (const [name, def] of Object.entries(toPatch)) {
      console.log(
        `   ~ ${name}: ${def.select.options.map((o) => o.name).join(", ")}`,
      );
    }
  }

  if (DRY_RUN) {
    console.log("\n--dry-run: nothing was written.");
    return;
  }

  console.log("\n→ Applying schema update…");
  await notion.dataSources.update({
    data_source_id: dataSourceId,
    properties: { ...toAdd, ...toPatch },
  });

  console.log("\n✓ Asset Collections can now hold smart collections.");
  console.log(
    "  Existing manual collections are untouched: their Type is empty, which " +
      "the app treats as \"manual\".",
  );
}

main().catch((err) => {
  console.error("✗ Setup failed:", err.body ?? err.message ?? err);
  process.exit(1);
});
