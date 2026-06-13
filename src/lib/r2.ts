import "server-only";

// Minimal Cloudflare R2 (S3-compatible) client for the upload path, signed
// with Node's built-in crypto — a runtime TypeScript port of
// scripts/lib-r2.mjs (which stays .mjs for the index cron job). Only PUT and
// HEAD are needed at runtime: objects are written once (HEAD makes derived
// PUTs idempotent) and then served by the brand CDN worker, never read back
// through the API process.

import { createHash, createHmac } from "node:crypto";

import { uploadConfig } from "./config";

const sha256hex = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data).digest();

export interface R2Config {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  endpoint: string;
}

/**
 * R2 config for asset storage, or null when env vars are missing.
 *
 * Uploaded originals are served by the brand CDN worker, which may read a
 * bucket in a *different* Cloudflare account than the search index. So the
 * asset path accepts its own credentials (`ASSET_R2_*`), each falling back to
 * the shared index credentials (`R2_*`) when unset — set the `ASSET_R2_*` ones
 * only when the CDN bucket lives in another account.
 */
export function assetsR2Config(): R2Config | null {
  const accountId = process.env.ASSET_R2_ACCOUNT_ID || process.env.R2_ACCOUNT_ID;
  const accessKeyId =
    process.env.ASSET_R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.ASSET_R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY;
  const bucket = uploadConfig.bucket;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    accessKeyId,
    secretAccessKey,
    bucket,
    region: process.env.ASSET_R2_REGION || process.env.R2_REGION || "auto",
    endpoint:
      process.env.ASSET_R2_ENDPOINT ||
      process.env.R2_ENDPOINT ||
      `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

/**
 * R2 config for the durable video queue (job records + source clips). Defaults
 * to the same credentials/bucket as asset uploads, but can point at a separate
 * (ideally private) bucket via `VIDEO_QUEUE_*`. Used by the web service (to
 * enqueue) and the background worker (to claim/process).
 */
export function videoQueueR2Config(): R2Config | null {
  const accountId =
    process.env.VIDEO_QUEUE_R2_ACCOUNT_ID ||
    process.env.ASSET_R2_ACCOUNT_ID ||
    process.env.R2_ACCOUNT_ID;
  const accessKeyId =
    process.env.VIDEO_QUEUE_R2_ACCESS_KEY_ID ||
    process.env.ASSET_R2_ACCESS_KEY_ID ||
    process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.VIDEO_QUEUE_R2_SECRET_ACCESS_KEY ||
    process.env.ASSET_R2_SECRET_ACCESS_KEY ||
    process.env.R2_SECRET_ACCESS_KEY;
  const bucket =
    process.env.VIDEO_QUEUE_BUCKET ||
    process.env.ASSET_R2_BUCKET ||
    process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    accessKeyId,
    secretAccessKey,
    bucket,
    region:
      process.env.VIDEO_QUEUE_R2_REGION ||
      process.env.ASSET_R2_REGION ||
      process.env.R2_REGION ||
      "auto",
    endpoint:
      process.env.VIDEO_QUEUE_R2_ENDPOINT ||
      process.env.ASSET_R2_ENDPOINT ||
      process.env.R2_ENDPOINT ||
      `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

// YYYYMMDDTHHMMSSZ from an ISO timestamp.
function amzDate(now: Date): string {
  return now.toISOString().replace(/[:-]/g, "").replace(/\.\d{3}/, "");
}

/** PUT an object into R2 with a SigV4-signed request. */
export async function r2PutObject(
  cfg: R2Config,
  key: string,
  body: Buffer,
  { contentType, cacheControl }: { contentType: string; cacheControl?: string },
): Promise<Response> {
  return r2Request(cfg, "PUT", key, { body, contentType, cacheControl });
}

/** HEAD an object — 200 when it exists, 404 otherwise. */
export async function r2HeadObject(
  cfg: R2Config,
  key: string,
): Promise<Response> {
  return r2Request(cfg, "HEAD", key, {});
}

/** DELETE an object (idempotent — R2 returns 204 even if it was already gone). */
export async function r2DeleteObject(
  cfg: R2Config,
  key: string,
): Promise<Response> {
  return r2Request(cfg, "DELETE", key, {});
}

/** GET an object's bytes. Throws on non-2xx. */
export async function r2GetObject(cfg: R2Config, key: string): Promise<Buffer> {
  const res = await r2Request(cfg, "GET", key, {});
  if (!res.ok) {
    throw new Error(`R2 GET ${key} failed (${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// RFC-3986 encoding (S3 also encodes ! ' ( ) * which encodeURIComponent skips).
function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * List object keys under a prefix (ListObjectsV2). Single page, up to 1000 keys
 * — plenty for a job queue. Signs the canonical query string per SigV4.
 */
export async function r2ListObjects(
  cfg: R2Config,
  prefix: string,
): Promise<string[]> {
  const params: Record<string, string> = {
    "list-type": "2",
    "max-keys": "1000",
    prefix,
  };
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${awsEncode(k)}=${awsEncode(params[k])}`)
    .join("&");

  const url = new URL(`${cfg.endpoint}/${cfg.bucket}?${canonicalQuery}`);
  const now = new Date();
  const date = amzDate(now);
  const dateStamp = date.slice(0, 8);
  const payloadHash = sha256hex("");

  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": date,
  };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((h) => `${h}:${headers[h]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalUri = url.pathname.split("/").map(encodeURIComponent).join("/");

  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    date,
    scope,
    sha256hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign)
    .digest("hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method: "GET",
    headers: { ...headers, Authorization: authorization },
  });
  if (!res.ok) {
    throw new Error(`R2 LIST failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const xml = await res.text();
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) =>
    m[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

async function r2Request(
  cfg: R2Config,
  method: "GET" | "PUT" | "HEAD" | "DELETE",
  key: string,
  {
    body,
    contentType,
    cacheControl,
  }: { body?: Buffer; contentType?: string; cacheControl?: string },
): Promise<Response> {
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${key}`);
  const now = new Date();
  const date = amzDate(now);
  const dateStamp = date.slice(0, 8);
  const service = "s3";
  const payloadHash = body ? sha256hex(body) : sha256hex("");

  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": date,
  };
  if (contentType) headers["content-type"] = contentType;
  if (cacheControl) headers["cache-control"] = cacheControl;

  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = names.map((h) => `${h}:${headers[h]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalUri = url.pathname
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  const canonicalRequest = [
    method,
    canonicalUri,
    "", // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${cfg.region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    date,
    scope,
    sha256hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign)
    .digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(url, {
    method,
    headers: { ...headers, Authorization: authorization },
    ...(body ? { body: new Uint8Array(body) } : {}),
  });
}
