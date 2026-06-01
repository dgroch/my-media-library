import { NextResponse } from "next/server";

import { searchAssets } from "@/lib/notion";
import { hasIndex, semanticSearch } from "@/lib/searchIndex";

// Always run on the server at request time (never statically cached).
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q") ?? "";
  const cursor = searchParams.get("cursor") ?? undefined;

  try {
    // Prefer semantic search when a prebuilt index is present.
    if (await hasIndex()) {
      try {
        const offset = cursor ? Number(cursor) : 0;
        const data = await semanticSearch(
          query,
          Number.isFinite(offset) ? offset : 0,
        );
        return NextResponse.json(data);
      } catch (semErr) {
        // Transient embedding failure — degrade to keyword search instead of
        // failing the request outright.
        console.error("semantic search failed, falling back to keyword", semErr);
      }
    }

    // Keyword fallback. A numeric cursor only makes sense to the semantic path,
    // so drop it here to avoid handing Notion an invalid start_cursor.
    const notionCursor =
      cursor && Number.isNaN(Number(cursor)) ? cursor : undefined;
    const data = await searchAssets(query, notionCursor);
    return NextResponse.json(data);
  } catch (err) {
    console.error("search failed", err);
    const message = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
