import { NextResponse } from "next/server";

import { getCollection } from "@/lib/notion";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const collection = await getCollection(id);
    if (!collection) {
      return NextResponse.json(
        { error: "Collection not found" },
        { status: 404 },
      );
    }
    return NextResponse.json(collection);
  } catch (err) {
    console.error("get collection failed", err);
    const message =
      err instanceof Error ? err.message : "Failed to load collection";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
