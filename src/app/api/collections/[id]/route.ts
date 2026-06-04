import { NextResponse } from "next/server";

import { checkWriteAuth } from "@/lib/auth";
import {
  deleteCollection,
  getCollection,
  renameCollection,
} from "@/lib/notion";

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

// Rename a collection. Same optional bearer-token gate as POST /api/collections.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = checkWriteAuth(request);
  if (denied) {
    return NextResponse.json({ error: denied.error }, { status: denied.status });
  }

  const { id } = await params;

  let body: { name?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json(
      { error: "Collection name cannot be empty." },
      { status: 400 },
    );
  }

  try {
    await renameCollection(id, name);
    return NextResponse.json({ id, name });
  } catch (err) {
    console.error("rename collection failed", err);
    const message =
      err instanceof Error ? err.message : "Failed to rename collection";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Delete (archive) a collection. Same optional bearer-token gate as above.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = checkWriteAuth(request);
  if (denied) {
    return NextResponse.json({ error: denied.error }, { status: denied.status });
  }

  const { id } = await params;

  try {
    await deleteCollection(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("delete collection failed", err);
    const message =
      err instanceof Error ? err.message : "Failed to delete collection";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
