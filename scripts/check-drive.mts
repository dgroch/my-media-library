// Preflight for the Google Drive mirror. Run this BEFORE relying on it, so a
// misconfigured service account shows up here rather than as silently missing
// Drive Links on real uploads (the mirror is best-effort by design — it logs
// and carries on, which is safe but quiet).
//
//   npm run check:drive
//
// Exercises the app's own drive.ts, not a copy, so what passes here is exactly
// what the upload path will do. It uploads a tiny test file to the configured
// folder and deletes it again.

import { driveConfig } from "../src/lib/config";
import {
  driveConfigured,
  driveMirrorState,
  driveUploadFile,
  explainDriveError,
} from "../src/lib/drive";

const RESET = "\x1b[0m";
const red = (s: string) => `\x1b[31m${s}${RESET}`;
const green = (s: string) => `\x1b[32m${s}${RESET}`;
const dim = (s: string) => `\x1b[2m${s}${RESET}`;

function fail(message: string, hint?: string): never {
  console.error(`${red("✗")} ${message}`);
  if (hint) console.error(dim(`  ${hint}`));
  process.exit(1);
}

// --- 1. Env ---------------------------------------------------------------

const state = driveMirrorState();
if (state.kind === "off") {
  fail(
    "Not configured — GOOGLE_DRIVE_CLIENT_EMAIL, GOOGLE_DRIVE_PRIVATE_KEY and GOOGLE_DRIVE_FOLDER_ID are all unset.",
    "With these unset the mirror is simply off; uploads still work, they just get no Drive Link.",
  );
}
if (state.kind === "misconfigured" || !driveConfigured()) {
  const missing = state.kind === "misconfigured" ? state.missing.join(", ") : "(unknown)";
  fail(
    `Half-configured — missing: ${missing}`,
    "Uploads succeed and none reach Drive; the only sign is driveMirror.status = \"failed\" on each response. Set the missing variable(s) on the deployment.",
  );
}
// The example file's placeholder, and the "your-project" variant that ended up
// on a real deployment once. Either authenticates as nobody.
if (/@(my|your)-project\.iam\.gserviceaccount\.com$/i.test(driveConfig.clientEmail)) {
  fail(
    `GOOGLE_DRIVE_CLIENT_EMAIL is a placeholder (${driveConfig.clientEmail}).`,
    "Paste the real `client_email` from the service account's JSON key file.",
  );
}
if (!/\.iam\.gserviceaccount\.com$/i.test(driveConfig.clientEmail)) {
  fail(
    `GOOGLE_DRIVE_CLIENT_EMAIL does not look like a service account (${driveConfig.clientEmail}).`,
    "It should end in .iam.gserviceaccount.com — a person's Google address cannot sign a service-account JWT.",
  );
}

console.log(`→ service account: ${driveConfig.clientEmail}`);
console.log(`→ folder:          ${driveConfig.folderId}`);
console.log(`→ scope:           ${driveConfig.scope}`);
console.log(
  `→ routing:         ${driveConfig.routing ? `on (root ${driveConfig.rootFolderId || driveConfig.folderId})` : "off"}`,
);

// A PEM pasted without escaping is the most common setup mistake, and it fails
// deep inside crypto with an opaque DECODER error. Catch it here instead.
const pem = driveConfig.privateKey.replace(/\\n/g, "\n");
if (!pem.includes("-----BEGIN") || !pem.includes("-----END")) {
  fail(
    "GOOGLE_DRIVE_PRIVATE_KEY does not look like a PEM key.",
    'Paste the JSON key file\'s `private_key` value verbatim, quoted, keeping its \\n escapes.',
  );
}

// --- 2. Round-trip a real file --------------------------------------------

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const name = `asset-library-drive-check-${stamp}.txt`;

console.log(dim(`\n→ uploading ${name} …`));

let file;
try {
  file = await driveUploadFile({
    name,
    mimeType: "text/plain",
    bytes: Buffer.from("Asset library Drive mirror preflight. Safe to delete.\n"),
  });
} catch (err) {
  // Same diagnosis the mirror itself logs and returns to uploaders, so what
  // this prints is exactly what a failing upload would say.
  const explained = explainDriveError(err);
  const raw = err instanceof Error ? err.message : String(err);
  const hint = explained.startsWith(raw) ? explained.slice(raw.length).replace(/^\s*—\s*/, "") : "";
  fail(raw, hint || undefined);
}

console.log(`${green("✓")} uploaded — ${file.webViewLink}`);

// --- 3. Clean up ----------------------------------------------------------

try {
  const { deleteDriveFile } = await import("../src/lib/drive");
  await deleteDriveFile(file.id);
  console.log(`${green("✓")} test file deleted`);
} catch (err) {
  console.warn(
    `${red("!")} could not delete the test file — remove ${file.id} by hand.`,
    err instanceof Error ? err.message : err,
  );
}

// --- 4. Folder routing ----------------------------------------------------

if (!driveConfig.routing) {
  console.log(dim("\n→ routing disabled — everything lands in the fallback folder"));
} else {
  console.log(dim("\n→ reading the folder tree …"));
  const { driveFolderTree, folderCandidates } = await import("../src/lib/driveFolders");
  let tree;
  try {
    tree = await driveFolderTree();
  } catch (err) {
    // The fallback folder was writable (step 2 passed) but the routing root
    // isn't readable — usually a GOOGLE_DRIVE_ROOT_FOLDER_ID that was never
    // shared with the account. The mirror would still work, unrouted.
    fail(
      explainDriveError(err),
      `GOOGLE_DRIVE_ROOT_FOLDER_ID (${driveConfig.rootFolderId || driveConfig.folderId}) must also be shared with ${driveConfig.clientEmail}; until it is, every upload lands in the fallback folder.`,
    );
  }

  if (tree.folders.length === 0) {
    console.warn(
      `${red("!")} No folders under the configured root — every upload will land in the fallback folder.`,
    );
  } else {
    console.log(
      `${green("✓")} ${tree.folders.length} folders${tree.truncated ? " (truncated — raise GOOGLE_DRIVE_MAX_DEPTH / _MAX_FOLDERS)" : ""}`,
    );
    for (const folder of tree.folders.filter((f) => f.depth === 1).slice(0, 12)) {
      const children = tree.folders.filter((f) => f.path.startsWith(`${folder.path}/`)).length;
      console.log(dim(`    ${folder.path}${children ? ` (${children} below)` : ""}`));
    }

    // Dry-run the shortlist so a misconfigured root shows up as obviously
    // wrong candidates rather than as quietly misfiled uploads later.
    const sample = "bouquet of white roses and eucalyptus, product photography";
    const candidates = folderCandidates(tree.folders, sample, "");
    console.log(dim(`\n  shortlist for "${sample}":`));
    console.log(
      dim(`    ${candidates.slice(0, 5).map((f) => f.path).join("  |  ") || "(none)"}`),
    );
  }
}

console.log(`\n${green("Drive mirror is ready.")} Uploads will get a Drive Link from here on.`);
