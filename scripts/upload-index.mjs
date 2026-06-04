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
