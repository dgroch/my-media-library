// Minimal Cloudflare R2 (S3-compatible) client using AWS SigV4, signed with
// Node's built-in crypto so we add no dependencies (keeps `npm ci` lockfile
// untouched). Only the two calls we need are implemented: GET and PUT object.
//
// Required env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// Optional env: R2_ENDPOINT (defaults to <account>.r2.cloudflarestorage.com),
//               R2_REGION (defaults to "auto"), R2_INDEX_PREFIX (key prefix).

import { createHash, createHmac } from "node:crypto";

const sha256hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** Returns a config object, or null if R2 env vars are not all present. */
export function r2Config(env) {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const bucket = env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    accessKeyId,
    secretAccessKey,
    bucket,
    region: env.R2_REGION || "auto",
    endpoint:
      env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`,
    prefix: env.R2_INDEX_PREFIX || "",
  };
}

// YYYYMMDDTHHMMSSZ from an ISO timestamp.
function amzDate(now) {
  return now.toISOString().replace(/[:-]/g, "").replace(/\.\d{3}/, "");
}

/** Perform a signed S3 request against R2. Returns the raw fetch Response. */
export async function r2Request(cfg, method, key, { body, contentType } = {}) {
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${key}`);
  const now = new Date();
  const date = amzDate(now);
  const dateStamp = date.slice(0, 8);
  const service = "s3";
  const payloadHash = body ? sha256hex(body) : sha256hex("");

  const headers = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": date,
  };
  if (contentType) headers["content-type"] = contentType;

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
    body,
  });
}

/** Object key for a local index file, applying the configured prefix. */
export function indexKey(cfg, filename) {
  return `${cfg.prefix}${filename}`;
}
