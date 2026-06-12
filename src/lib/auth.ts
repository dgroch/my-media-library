import "server-only";

// Optional bearer-token gate for write endpoints (currently POST
// /api/collections).
//
// Default-off: when `API_WRITE_TOKEN` is unset the app behaves exactly as
// before — anyone can create a collection, which is what the no-login browser
// UI relies on. Set `API_WRITE_TOKEN` in the environment to require callers to
// send `Authorization: Bearer <token>`; this is intended for deployments that
// expose the API to programmatic clients (Claude, an agent, a cron job) and
// want to keep writes private. Enabling it will also stop the in-browser
// "Save collection" flow from working, since the browser has no safe place to
// hold the secret.

import { createHash, timingSafeEqual } from "node:crypto";

import { uploadConfig } from "./config";

export interface AuthFailure {
  status: number;
  error: string;
}

// ---------------------------------------------------------------------------
// Browser session (for the in-app upload / review pages)
// ---------------------------------------------------------------------------
// The asset token must never live in client JS. Instead the upload UI exchanges
// it once at POST /api/session for an httpOnly cookie holding sha256(token);
// subsequent same-origin asset writes are authorised by that cookie. The raw
// token is never readable from the browser, and the cookie only carries a hash.

export const ASSET_SESSION_COOKIE = "al_session";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The cookie value a valid session carries (the hash of the configured token). */
export function assetSessionValue(): string {
  return sha256(uploadConfig.token);
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/** True when the request carries a valid asset-session cookie. */
export function hasValidAssetSession(request: Request): boolean {
  if (!uploadConfig.token) return false;
  const value = cookieValue(request, ASSET_SESSION_COOKIE);
  return Boolean(value) && safeEqual(value as string, assetSessionValue());
}

/**
 * Returns `null` when the request is authorised (or when no token is
 * configured), otherwise an `AuthFailure` describing why it was rejected.
 */
export function checkWriteAuth(request: Request): AuthFailure | null {
  const expected = process.env.API_WRITE_TOKEN;
  if (!expected) return null; // gate disabled

  return checkBearer(request, expected);
}

/**
 * Auth gate for asset writes (POST /api/assets, PATCH /api/assets/:id).
 * Unlike collections, this is never open: asset uploads create permanent CDN
 * objects and manifest rows, so they stay disabled until ASSET_LIBRARY_TOKEN
 * is configured. Browser clients never hold the token — consumer apps (the
 * social builder) proxy uploads through their own servers.
 */
export function checkAssetWriteAuth(request: Request): AuthFailure | null {
  const expected = uploadConfig.token;
  if (!expected) {
    return {
      status: 503,
      error:
        "Asset uploads are disabled: set ASSET_LIBRARY_TOKEN on the deployment.",
    };
  }
  // The in-app upload UI authenticates with a session cookie (set at
  // /api/session); programmatic clients still send a bearer token.
  if (hasValidAssetSession(request)) return null;
  return checkBearer(request, expected);
}

function checkBearer(request: Request, expected: string): AuthFailure | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const provided = match?.[1];

  if (!provided) {
    return { status: 401, error: "Missing bearer token." };
  }
  if (provided !== expected) {
    return { status: 403, error: "Invalid bearer token." };
  }
  return null;
}
