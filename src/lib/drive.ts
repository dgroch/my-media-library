import "server-only";

// Minimal Google Drive v3 client for mirroring uploaded originals, signed with
// Node's built-in crypto in the same spirit as r2.ts — no `googleapis` dep for
// the two calls we actually make (token exchange, multipart upload).
//
// Why mirror at all: the CDN object written by the ingest path is already the
// untouched original, so this is a backup / browsability feature, not a
// fidelity one. That is also why every failure here is non-fatal — the asset is
// safely stored before we ever talk to Drive.

import { createSign } from "node:crypto";

import { driveConfig } from "./config";

export interface DriveFile {
  id: string;
  /** Human-openable Drive URL, stored on the row as `Drive Link`. */
  webViewLink: string;
}

export function driveConfigured(): boolean {
  return Boolean(
    driveConfig.clientEmail && driveConfig.privateKey && driveConfig.folderId,
  );
}

/** The required env vars that are unset, in the order they are documented. */
export function driveMissingConfig(): string[] {
  return (
    [
      ["GOOGLE_DRIVE_CLIENT_EMAIL", driveConfig.clientEmail],
      ["GOOGLE_DRIVE_PRIVATE_KEY", driveConfig.privateKey],
      ["GOOGLE_DRIVE_FOLDER_ID", driveConfig.folderId],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

/**
 * Off (none of the required vars set), on, or half-set. Half-set is the case
 * that bit us in production: a service account without a folder id looks, from
 * the outside, exactly like the mirror being deliberately off — every upload
 * succeeded and none reached Drive. So it is reported as a misconfiguration,
 * not as "off".
 */
export type DriveMirrorState =
  | { kind: "off" }
  | { kind: "on" }
  | { kind: "misconfigured"; missing: string[] };

export function driveMirrorState(): DriveMirrorState {
  const missing = driveMissingConfig();
  if (missing.length === 0) return { kind: "on" };
  if (missing.length === 3) return { kind: "off" };
  return { kind: "misconfigured", missing };
}

/**
 * Turn a Drive API error into the sentence that names the fix. The raw errors
 * are accurate but each one points somewhere different, and the mirror is the
 * kind of thing nobody looks at until it has been silently broken for weeks.
 */
export function explainDriveError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/account not found/i.test(message)) {
    return `${message} — GOOGLE_DRIVE_CLIENT_EMAIL is not a real service account (still the placeholder?), or its key file is from a different account.`;
  }
  if (/invalid_grant/i.test(message)) {
    return `${message} — the service account or its key is wrong: check client_email and private_key came from the same JSON key file.`;
  }
  if (/has not been used in project|is disabled/i.test(message)) {
    const link = /https:\/\/console\.developers\.google\.com\S+/.exec(message)?.[0];
    return `${message} — the Google Drive API is not enabled in the service account's Cloud project. Enable it${link ? ` at ${link}` : " in the Cloud console"}, then retry.`;
  }
  if (/storageQuotaExceeded|storage quota/i.test(message)) {
    // Files created in a My Drive folder are owned by the service account and
    // count against its own (small) quota. Shared Drive files belong to the
    // drive instead.
    return `${message} — the service account's own Drive storage is full: file into a Shared Drive (its files are owned by the drive, not the account), or free space in the account's My Drive.`;
  }
  if (/\(403\)/.test(message)) {
    return `${message} — authenticated but not allowed to write there: share the folder (or Shared Drive) with ${driveConfig.clientEmail} as Editor / Content manager, and make sure GOOGLE_DRIVE_SCOPE is the full https://www.googleapis.com/auth/drive scope.`;
  }
  if (/\(404\)/.test(message)) {
    return `${message} — the destination folder (GOOGLE_DRIVE_FOLDER_ID, or the routed folder named in the error) does not resolve for this service account: check the id is the last path segment of the folder's Drive URL, that the folder still exists, and that it is shared with ${driveConfig.clientEmail}.`;
  }
  return message;
}

// --- Service-account auth -------------------------------------------------
// Tokens last an hour; cache until shortly before expiry so a burst of uploads
// makes one token call, not one per file.

let cachedToken: { value: string; expiresAt: number } | null = null;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.value;

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: driveConfig.clientEmail,
      scope: driveConfig.scope,
      aud: driveConfig.tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  // Env vars can't hold real newlines — accept the usual "\n" escaping.
  const pem = driveConfig.privateKey.replace(/\\n/g, "\n");
  const signature = base64url(signer.sign(pem));

  const res = await fetch(driveConfig.tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Drive token exchange failed (${res.status}): ${detail.slice(0, 300)}`,
    );
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    value: body.access_token,
    expiresAt: now + (body.expires_in ?? 3600),
  };
  return cachedToken.value;
}

// --- Upload ---------------------------------------------------------------

/**
 * Upload bytes to the configured Drive folder and return the file's id and
 * view link. Throws on failure — callers treat that as non-fatal.
 */
export async function driveUploadFile(params: {
  name: string;
  mimeType: string;
  bytes: Buffer;
  /** Destination folder; defaults to the configured fallback folder. */
  parentId?: string;
}): Promise<DriveFile> {
  const token = await accessToken();
  const boundary = `mml-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const metadata = JSON.stringify({
    name: params.name,
    parents: [params.parentId || driveConfig.folderId],
  });

  // multipart/related: a JSON metadata part, then the raw media part. Built as
  // a Buffer so the binary body isn't mangled by string encoding.
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\ncontent-type: ${params.mimeType}\r\n\r\n`,
    ),
    params.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const url = new URL(`${driveConfig.uploadBaseUrl}/files`);
  url.searchParams.set("uploadType", "multipart");
  // Required for Shared Drives, harmless on My Drive.
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "id,webViewLink");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": `multipart/related; boundary=${boundary}`,
    },
    // Buffer is already a Uint8Array — passing it straight through avoids a
    // second full copy of the payload, which matters on the video path where
    // a clip can be 100MB.
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // Name the parent: the router may have chosen it, so "the folder" is not
    // necessarily GOOGLE_DRIVE_FOLDER_ID.
    throw new Error(
      `Drive upload failed (${res.status}) into folder ${params.parentId || driveConfig.folderId}: ${detail.slice(0, 300)}`,
    );
  }
  const file = (await res.json()) as { id: string; webViewLink?: string };
  return {
    id: file.id,
    webViewLink: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
  };
}

/** Immediate child folders of `parentId`, following pagination. */
export async function driveListChildFolders(
  parentId: string,
): Promise<Array<{ id: string; name: string }>> {
  const token = await accessToken();
  const out: Array<{ id: string; name: string }> = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${driveConfig.apiBaseUrl}/files`);
    url.searchParams.set(
      "q",
      `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    );
    url.searchParams.set("fields", "nextPageToken,files(id,name)");
    url.searchParams.set("pageSize", "1000");
    // Shared Drives need both of these or the query returns nothing.
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Drive folder listing failed (${res.status}): ${detail.slice(0, 300)}`,
      );
    }
    const json = (await res.json()) as {
      nextPageToken?: string;
      files?: Array<{ id: string; name: string }>;
    };
    out.push(...(json.files ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);

  return out;
}

/**
 * Delete a Drive file. Only used by the `check:drive` preflight to clean up
 * after its test upload — the mirror itself never deletes.
 */
export async function deleteDriveFile(fileId: string): Promise<void> {
  const token = await accessToken();
  const url = new URL(`${driveConfig.apiBaseUrl}/files/${fileId}`);
  url.searchParams.set("supportsAllDrives", "true");
  const res = await fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Drive delete failed (${res.status}): ${detail.slice(0, 300)}`);
  }
}

/**
 * What happened to the Drive copy of an upload. Returned to the uploader so a
 * broken mirror is visible on every upload rather than only in server logs.
 *
 * - `mirrored`: the file is in Drive at `link`.
 * - `skipped`: the mirror is off (no GOOGLE_DRIVE_* configured) — by design.
 * - `failed`: it should have worked and didn't; `reason` names the fix.
 */
export type DriveMirrorOutcome =
  | {
      status: "mirrored";
      link: string;
      fileId: string;
      folder: string;
      /** False when the file reached Drive but the row could not be updated with its link. */
      recorded?: boolean;
    }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Mirror an uploaded original to Drive. Never throws: the CDN object is the
 * original, so a missing mirror costs a backup, not the asset. The outcome says
 * which of the three things happened.
 */
export async function mirrorToDrive(params: {
  name: string;
  mimeType: string;
  bytes: Buffer;
  parentId?: string;
  /** Human-readable destination, for the log line and the outcome. */
  parentPath?: string;
}): Promise<{ file: DriveFile | null; outcome: DriveMirrorOutcome }> {
  const state = driveMirrorState();
  if (state.kind === "off") {
    return { file: null, outcome: { status: "skipped", reason: "Drive mirror not configured" } };
  }
  if (state.kind === "misconfigured") {
    const reason = `Drive mirror is half-configured: ${state.missing.join(", ")} not set`;
    console.error(`[drive-mirror] ${reason} — asset kept on the CDN only`);
    return { file: null, outcome: { status: "failed", reason } };
  }
  const folder = params.parentPath || "(fallback folder)";
  try {
    const file = await driveUploadFile(params);
    console.log(`[drive-mirror] ${params.name} → ${folder} (${file.id})`);
    return {
      file,
      outcome: { status: "mirrored", link: file.webViewLink, fileId: file.id, folder },
    };
  } catch (err) {
    const reason = explainDriveError(err);
    console.error(`[drive-mirror] failed, asset kept on the CDN only — ${reason}`);
    return { file: null, outcome: { status: "failed", reason } };
  }
}
