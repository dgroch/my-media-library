import { NextResponse } from "next/server";

import {
  ASSET_SESSION_COOKIE,
  assetSessionValue,
  hasValidAssetSession,
} from "@/lib/auth";
import { uploadConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

// The browser session for the in-app upload / review pages. The user exchanges
// the ASSET_LIBRARY_TOKEN once for an httpOnly cookie; the raw token never
// touches client JS. See src/lib/auth.ts.

const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** Session status — lets the UI decide between the gate and the page. */
export function GET(request: Request) {
  return NextResponse.json({
    configured: Boolean(uploadConfig.token),
    authed: hasValidAssetSession(request),
  });
}

/** Exchange the asset token for a session cookie. */
export async function POST(request: Request) {
  if (!uploadConfig.token) {
    return NextResponse.json(
      { error: "Asset uploads are disabled: set ASSET_LIBRARY_TOKEN." },
      { status: 503 },
    );
  }

  let body: { token?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) {
    return NextResponse.json({ error: "Missing token." }, { status: 400 });
  }
  if (token !== uploadConfig.token) {
    return NextResponse.json({ error: "Invalid token." }, { status: 403 });
  }

  const res = NextResponse.json({ authed: true });
  res.cookies.set(ASSET_SESSION_COOKIE, assetSessionValue(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return res;
}

/** Sign out — clear the session cookie. */
export function DELETE() {
  const res = NextResponse.json({ authed: false });
  res.cookies.set(ASSET_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
