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

import { uploadConfig } from "./config";

export interface AuthFailure {
  status: number;
  error: string;
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
