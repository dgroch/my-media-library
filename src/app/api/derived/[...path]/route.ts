import { NextResponse } from "next/server";

import { checkAssetWriteAuth } from "@/lib/auth";
import { uploadConfig } from "@/lib/config";
import { assetsR2Config, r2HeadObject, r2PutObject } from "@/lib/r2";

// Derived objects: content-addressed CDN storage for things *derived from*
// brand assets — e.g. the social builder's render cache
// (PUT /api/derived/render/<hash>.png). The one rule that matters: derived
// objects are NOT brand assets. They live under a separate namespace, outside
// the manifest — no Notion row, no dedup, no AI enrichment, and they can
// never appear in /api/search (a rendered post containing a photo of Kellie
// must not become a search hit for "Kellie").
//
// PUTs are idempotent: the caller names the object by its own content hash,
// so re-PUTting an existing key is a no-op 200. Eviction is the storage
// layer's problem (an R2 lifecycle rule), not the API's — a cold miss just
// re-renders.

export const dynamic = "force-dynamic";

// Conservative key grammar: 1+ namespace segments plus a filename with an
// extension, lowercase alnum/dash/underscore (content hashes fit naturally).
const SEGMENT = /^[a-z0-9][a-z0-9_-]*$/;
const FILENAME = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9]{2,5}$/;
const MAX_KEY_LENGTH = 512;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml",
  json: "application/json",
  pdf: "application/pdf",
};

function errorJson(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const denied = checkAssetWriteAuth(request);
  if (denied) return errorJson(denied.status, denied.error);

  const r2 = assetsR2Config();
  if (!r2) {
    return errorJson(
      503,
      "Derived-object storage is not configured: set the R2_* variables.",
    );
  }

  const { path } = await params;
  if (!Array.isArray(path) || path.length < 2) {
    return errorJson(
      400,
      "Expected PUT /api/derived/<namespace>/<name>.<ext> (e.g. /api/derived/render/<hash>.png).",
    );
  }
  const filename = path[path.length - 1].toLowerCase();
  const namespaces = path.slice(0, -1).map((s) => s.toLowerCase());
  if (!namespaces.every((s) => SEGMENT.test(s)) || !FILENAME.test(filename)) {
    return errorJson(
      400,
      "Invalid path: lowercase letters, digits, `-`/`_` segments and a file extension only.",
    );
  }

  const key = `${uploadConfig.derivedPrefix}${[...namespaces, filename].join("/")}`;
  if (key.length > MAX_KEY_LENGTH) {
    return errorJson(400, "Path too long.");
  }
  const url = uploadConfig.derivedCdnBaseUrl
    ? `${uploadConfig.derivedCdnBaseUrl}/${[...namespaces, filename].join("/")}`
    : undefined;

  let body: Buffer;
  try {
    body = Buffer.from(await request.arrayBuffer());
  } catch {
    return errorJson(400, "Could not read the request body.");
  }
  if (body.length === 0) {
    return errorJson(400, "Empty body.");
  }
  if (body.length > uploadConfig.maxBytes) {
    return errorJson(
      413,
      `Object too large: ${body.length} bytes (max ${uploadConfig.maxBytes}).`,
    );
  }

  try {
    // Content-addressed key ⇒ if it exists, the bytes are (by contract) the
    // same. No-op instead of rewriting, so re-PUTs are cheap and the object's
    // storage timestamp stays meaningful for lifecycle rules.
    const head = await r2HeadObject(r2, key);
    if (head.ok) {
      return NextResponse.json({ key, url, existed: true });
    }

    // The extension is authoritative for the served content-type (clients
    // like curl often send a misleading default header on raw PUTs).
    const ext = filename.slice(filename.lastIndexOf(".") + 1);
    const put = await r2PutObject(r2, key, body, {
      contentType:
        MIME_BY_EXT[ext] ||
        request.headers.get("content-type")?.split(";")[0].trim() ||
        "application/octet-stream",
      cacheControl: "public, max-age=31536000, immutable",
    });
    if (!put.ok) {
      const detail = await put.text().catch(() => "");
      console.error("derived: R2 PUT failed", put.status, detail);
      return errorJson(502, "Failed to store the object.");
    }

    return NextResponse.json({ key, url, existed: false }, { status: 201 });
  } catch (err) {
    console.error("derived put failed", err);
    const message = err instanceof Error ? err.message : "Store failed";
    return errorJson(502, message);
  }
}
