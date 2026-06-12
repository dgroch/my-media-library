import { NextResponse } from "next/server";

import {
  embeddingTextForEntry,
  getAssetPage,
  pageToManifestEntry,
  parseRightsKind,
  updateAssetEntry,
  validatePeople,
  validateTags,
  type AssetMetadataInput,
  type ManifestEntry,
} from "@/lib/assets";
import { checkAssetWriteAuth } from "@/lib/auth";
import { embedQuery } from "@/lib/embeddings";
import { deleteAsset } from "@/lib/ingest";
import { isSearchable, upsertRuntimeAsset } from "@/lib/searchIndex";

export const dynamic = "force-dynamic";

function withStatus(entry: ManifestEntry) {
  return {
    ...entry,
    status: isSearchable(entry.id) ? "ready" : "processing",
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const page = await getAssetPage(id);
    if (!page) {
      return NextResponse.json({ error: "Asset not found" }, { status: 404 });
    }
    return NextResponse.json(withStatus(pageToManifestEntry(page)));
  } catch (err) {
    console.error("get asset failed", err);
    const message = err instanceof Error ? err.message : "Failed to load asset";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * The backfill path: add or correct human context on any manifest entry —
 * including years-old Drive-synced assets — and it becomes findable. Provided
 * fields replace the stored values; omitted fields are untouched. The entry
 * is re-embedded so search reflects the change immediately.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = checkAssetWriteAuth(request);
  if (denied) {
    return NextResponse.json({ error: denied.error }, { status: denied.status });
  }

  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let patch: AssetMetadataInput;
  try {
    patch = parsePatch(body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid body" },
      { status: 400 },
    );
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: "No metadata fields to update." },
      { status: 400 },
    );
  }

  try {
    const page = await getAssetPage(id);
    if (!page) {
      return NextResponse.json({ error: "Asset not found" }, { status: 404 });
    }

    const entry = await updateAssetEntry(page, patch);

    // Re-embed on change (best-effort) so e.g. "that's Kellie" is findable
    // right away rather than after the nightly re-index.
    let vector: number[] | null = null;
    try {
      vector = await embedQuery(embeddingTextForEntry(entry));
    } catch (err) {
      console.error("patch: re-embedding failed", err);
    }
    upsertRuntimeAsset(entry, vector);

    return NextResponse.json(withStatus(entry));
  } catch (err) {
    console.error("patch asset failed", err);
    const message = err instanceof Error ? err.message : "Failed to update asset";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Delete an asset: archive the Manifest row, drop it from search, and remove
 * its CDN object. Soft-delete (Notion has no hard delete), so the nightly
 * re-index folds out the archived row.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = checkAssetWriteAuth(request);
  if (denied) {
    return NextResponse.json({ error: denied.error }, { status: denied.status });
  }

  const { id } = await params;
  try {
    const page = await getAssetPage(id);
    if (!page) {
      return NextResponse.json({ error: "Asset not found" }, { status: 404 });
    }
    await deleteAsset(page);
    return NextResponse.json({ deleted: true, id });
  } catch (err) {
    console.error("delete asset failed", err);
    const message = err instanceof Error ? err.message : "Failed to delete asset";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function parsePatch(body: Record<string, unknown>): AssetMetadataInput {
  const patch: AssetMetadataInput = {};

  const str = (field: "context" | "product" | "location" | "shoot" | "credit" | "source" | "uploaded_by") => {
    const value = body[field];
    if (value === undefined) return;
    if (typeof value !== "string") {
      throw new Error(`Invalid \`${field}\`: must be a string.`);
    }
    patch[field] = value.trim();
  };
  str("context");
  str("product");
  str("location");
  str("shoot");
  str("credit");
  str("source");
  str("uploaded_by");

  if (body.people !== undefined) patch.people = validatePeople(body.people);
  if (body.tags !== undefined) patch.tags = validateTags(body.tags);

  if (body.rights !== undefined) {
    const rights = body.rights;
    if (typeof rights === "string") {
      patch.rights = { kind: parseRightsKind(rights) };
    } else if (rights && typeof rights === "object") {
      const r = rights as { kind?: unknown; notes?: unknown };
      patch.rights = {};
      if (r.kind !== undefined) {
        if (typeof r.kind !== "string") {
          throw new Error("Invalid `rights.kind`: must be a string.");
        }
        patch.rights.kind = parseRightsKind(r.kind);
      }
      if (r.notes !== undefined) {
        if (typeof r.notes !== "string") {
          throw new Error("Invalid `rights.notes`: must be a string.");
        }
        patch.rights.notes = r.notes.trim();
      }
    } else {
      throw new Error(
        'Invalid `rights`: must be "internal" | "licensed" | "restricted" or {kind, notes}.',
      );
    }
  }

  return patch;
}
