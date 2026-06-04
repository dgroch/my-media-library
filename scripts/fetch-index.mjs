// Fetch the prebuilt search index from Cloudflare R2 into src/data/ before the
// app build, so deploys consume a ready-made index instead of re-embedding the
// whole manifest. Runs as part of the web service build command.
//
// This step is intentionally non-fatal: if R2 isn't configured, the object is
// missing, or the network hiccups, we keep whatever index is already on disk
// (the committed placeholder if nothing else) and let the build proceed. Search
// degrades gracefully when the index is empty (see src/lib/searchIndex.ts).

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import { env } from "./lib-env.mjs";
import { indexKey, r2Config, r2Request } from "./lib-r2.mjs";

const OUT_PATH = env.ASSET_INDEX_PATH || "src/data/asset-index.json";
const VEC_PATH = OUT_PATH.replace(/\.json$/, "") + ".vec.bin";

const cfg = r2Config(env);
if (!cfg) {
  console.log(
    "ℹ R2 not configured; skipping index fetch and using the on-disk index.",
  );
  process.exit(0);
}

async function get(localPath) {
  const key = indexKey(cfg, basename(localPath));
  const res = await r2Request(cfg, "GET", key);
  if (res.status === 404) {
    console.log(`  – ${key} not found in R2; skipping`);
    return false;
  }
  if (!res.ok) {
    throw new Error(`fetch ${key} failed (${res.status}): ${await res.text()}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, buf);
  console.log(`  ↓ ${key} (${(buf.length / 1e6).toFixed(1)} MB)`);
  return true;
}

async function main() {
  console.log(`→ Fetching prebuilt index from R2 bucket "${cfg.bucket}"…`);
  const okJson = await get(OUT_PATH);
  const okVec = await get(VEC_PATH);
  if (okJson && okVec) {
    console.log("✓ Index ready.");
  } else {
    console.log(
      "⚠ Index not fully present in R2; using on-disk index " +
        "(search may be empty until the first re-index runs).",
    );
  }
}

main().catch((err) => {
  // Never fail the app build because of an index fetch problem.
  console.error(
    "⚠ Index fetch failed; continuing build with the on-disk index:",
    err.message ?? err,
  );
});
