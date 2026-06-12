import { NextResponse } from "next/server";

import { getAssetPage } from "@/lib/assets";
import { checkAssetWriteAuth } from "@/lib/auth";
import { recleanAsset } from "@/lib/ingest";

export const dynamic = "force-dynamic";

/**
 * Re-run caption / on-screen-text / chrome removal on an already-stored asset
 * (for uploads where "remove chrome" wasn't enabled at upload time). Overwrites
 * the same CDN object, so the URL is unchanged, and re-manifests the result.
 */
export async function POST(
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
    const result = await recleanAsset(page);
    return NextResponse.json({ cleaned: result.cleaned, ...result.entry });
  } catch (err) {
    console.error("reclean asset failed", err);
    const message = err instanceof Error ? err.message : "Failed to clean asset";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
