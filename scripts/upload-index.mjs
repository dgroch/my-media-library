// Upload the prebuilt search index to Cloudflare R2 so app deploys can consume
// it without re-embedding. Run after `npm run build:index` (see `npm run
// reindex`). Intended to run on the Render cron job, not on the web deploy.
//
// Requires the R2_* env vars (see lib-r2.mjs). Optionally set
// RENDER_DEPLOY_HOOK_URL to trigger a web service redeploy once the new index
// is uploaded.

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import { env } from "./lib-env.mjs";
import { indexKey, r2Config, r2Request } from "./lib-r2.mjs";

const OUT_PATH = env.ASSET_INDEX_PATH || "src/data/asset-index.json";
const VEC_PATH = OUT_PATH.replace(/\.json$/, "") + ".vec.bin";

const cfg = r2Config(env);
if (!cfg) {
  console.error(
    "✗ R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, " +
      "R2_SECRET_ACCESS_KEY and R2_BUCKET.",
  );
  process.exit(1);
}

// Refuse to replace the published index with a drastically smaller one. On
// July 12 a buggy fetch produced a 172-asset build (from ~8.6k) and the upload
// happily replaced the full index with it. Any future regression of that shape
// should fail the cron run loudly instead of silently gutting search.
// Override for an intentional shrink with ALLOW_INDEX_SHRINK=1.
const MIN_COUNT_RATIO = Number(env.INDEX_MIN_COUNT_RATIO || "0.5");

async function guardAgainstShrink(newCount) {
  if (env.ALLOW_INDEX_SHRINK === "1") {
    console.log("ℹ ALLOW_INDEX_SHRINK=1 — skipping shrink guard.");
    return;
  }
  const key = indexKey(cfg, basename(OUT_PATH));
  let published;
  try {
    const res = await r2Request(cfg, "GET", key);
    if (res.status === 404) return; // first upload — nothing to compare
    if (!res.ok) {
      console.warn(`⚠ Could not read published index (${res.status}); skipping shrink guard.`);
      return;
    }
    published = JSON.parse(Buffer.from(await res.arrayBuffer()).toString("utf8"));
  } catch (err) {
    console.warn(`⚠ Shrink guard check failed (${err.message}); continuing.`);
    return;
  }
  const oldCount = Number(published?.count) || 0;
  if (oldCount > 0 && newCount < oldCount * MIN_COUNT_RATIO) {
    throw new Error(
      `new index has ${newCount} assets but the published index has ${oldCount} ` +
        `(below the ${MIN_COUNT_RATIO} ratio floor). Refusing to replace it — ` +
        `this usually means the manifest fetch was incomplete. ` +
        `Set ALLOW_INDEX_SHRINK=1 to override an intentional shrink.`,
    );
  }
  console.log(`  shrink guard ok: ${newCount} new vs ${oldCount} published assets`);
}

async function put(localPath, contentType) {
  if (!existsSync(localPath)) {
    throw new Error(`${localPath} not found — run \`npm run build:index\` first`);
  }
  const body = readFileSync(localPath);
  const key = indexKey(cfg, basename(localPath));
  const res = await r2Request(cfg, "PUT", key, { body, contentType });
  if (!res.ok) {
    throw new Error(`upload ${key} failed (${res.status}): ${await res.text()}`);
  }
  console.log(`  ↑ ${key} (${(body.length / 1e6).toFixed(1)} MB)`);
}

async function main() {
  if (!existsSync(OUT_PATH)) {
    throw new Error(`${OUT_PATH} not found — run \`npm run build:index\` first`);
  }
  const built = JSON.parse(readFileSync(OUT_PATH, "utf8"));
  await guardAgainstShrink(Number(built?.count) || 0);

  console.log(`→ Uploading index to R2 bucket "${cfg.bucket}"…`);
  await put(OUT_PATH, "application/json");
  await put(VEC_PATH, "application/octet-stream");
  console.log("✓ Index uploaded.");

  const hook = env.RENDER_DEPLOY_HOOK_URL;
  if (hook) {
    const res = await fetch(hook, { method: "POST" });
    console.log(
      res.ok
        ? "✓ Triggered web service redeploy."
        : `⚠ Deploy hook returned ${res.status}; redeploy manually if needed.`,
    );
  } else {
    console.log(
      "ℹ Set RENDER_DEPLOY_HOOK_URL to auto-redeploy the web service after re-index.",
    );
  }
}

main().catch((err) => {
  console.error("\n✗ Upload failed:", err.message ?? err);
  process.exit(1);
});
