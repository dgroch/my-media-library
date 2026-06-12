import { NextResponse } from "next/server";

import { listRecentManifestEntries, type ManifestEntry } from "@/lib/assets";
import { checkAssetWriteAuth } from "@/lib/auth";
import { isSearchable } from "@/lib/searchIndex";

export const dynamic = "force-dynamic";

// Recent uploads, newest first — backs the post-upload review/edit page. Gated
// behind the same auth as writes (session cookie or bearer): it exposes the
// full human + AI manifest of every row, which is more than public search returns.

function withStatus(entry: ManifestEntry) {
  return { ...entry, status: isSearchable(entry.id) ? "ready" : "processing" };
}

export async function GET(request: Request) {
  const denied = checkAssetWriteAuth(request);
  if (denied) {
    return NextResponse.json({ error: denied.error }, { status: denied.status });
  }

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? "30");

  try {
    const entries = await listRecentManifestEntries(
      Number.isFinite(limit) ? limit : 30,
    );
    return NextResponse.json({ results: entries.map(withStatus) });
  } catch (err) {
    console.error("recent assets failed", err);
    const message = err instanceof Error ? err.message : "Failed to load uploads";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
