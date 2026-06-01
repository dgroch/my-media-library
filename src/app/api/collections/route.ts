import { NextResponse } from "next/server";

import { createCollection } from "@/lib/notion";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { name?: string; assetIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const assetIds = Array.isArray(body.assetIds)
    ? body.assetIds.filter((id): id is string => typeof id === "string")
    : [];

  if (assetIds.length === 0) {
    return NextResponse.json(
      { error: "Select at least one asset before saving a collection." },
      { status: 400 },
    );
  }

  try {
    const { id } = await createCollection(name, assetIds);
    return NextResponse.json({ id });
  } catch (err) {
    console.error("create collection failed", err);
    const message =
      err instanceof Error ? err.message : "Failed to create collection";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
