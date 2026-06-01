import { NextResponse } from "next/server";

import { searchAssets } from "@/lib/notion";

// Always run on the server at request time (never statically cached) so
// queries hit Notion live.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q") ?? "";
  const cursor = searchParams.get("cursor") ?? undefined;

  try {
    const data = await searchAssets(query, cursor);
    return NextResponse.json(data);
  } catch (err) {
    console.error("search failed", err);
    const message = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
