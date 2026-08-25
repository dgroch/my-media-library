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
}): Promise<DriveFile> {
  const token = await accessToken();
  const boundary = `mml-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const metadata = JSON.stringify({
    name: params.name,
    parents: [driveConfig.folderId],
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
    throw new Error(`Drive upload failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const file = (await res.json()) as { id: string; webViewLink?: string };
  return {
    id: file.id,
    webViewLink: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
  };
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
 * Mirror an uploaded original to Drive, returning null (never throwing) when
 * Drive isn't configured or the call fails. The CDN object is the original, so
 * a missing mirror costs a backup, not the asset.
 */
export async function mirrorToDrive(params: {
  name: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<DriveFile | null> {
  if (!driveConfigured()) return null;
  try {
    const file = await driveUploadFile(params);
    console.log(`[drive-mirror] ${params.name} → ${file.id}`);
    return file;
  } catch (err) {
    console.error("[drive-mirror] failed, asset kept on the CDN only —", err);
    return null;
  }
}
