import "server-only";

// Minimal Cloudflare R2 (S3-compatible) client for the upload path, signed
// with Node's built-in crypto — a runtime TypeScript port of
// scripts/lib-r2.mjs (which stays .mjs for the index cron job). Only PUT is
// needed at runtime: uploaded originals are written once and then served by
// the brand CDN worker, never read back through the API process.

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

/** R2 config for asset storage, or null when env vars are missing. */
export function assetsR2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = uploadConfig.bucket;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    accessKeyId,
    secretAccessKey,
    bucket,
    region: process.env.R2_REGION || "auto",
    endpoint:
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
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${key}`);
  const now = new Date();
  const date = amzDate(now);
  const dateStamp = date.slice(0, 8);
  const service = "s3";
  const payloadHash = sha256hex(body);

  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": date,
    "content-type": contentType,
  };
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
    "PUT",
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
    method: "PUT",
    headers: { ...headers, Authorization: authorization },
    body: new Uint8Array(body),
  });
}
