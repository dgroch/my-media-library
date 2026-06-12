import heicConvert from "heic-convert";
import { NextResponse } from "next/server";

import {
  ACCEPTED_TYPES,
  MAX_UPLOAD_BYTES,
  manifestSupportsUploads,
  readAssetMetadataForm,
  resolveUploadMime,
  type AssetMetadataInput,
} from "@/lib/assets";
import { checkAssetWriteAuth } from "@/lib/auth";
import { uploadConfig } from "@/lib/config";
import { ingestImage } from "@/lib/ingest";
import { assetsR2Config } from "@/lib/r2";

export const dynamic = "force-dynamic";

function errorJson(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: Request) {
  const denied = checkAssetWriteAuth(request);
  if (denied) return errorJson(denied.status, denied.error);

  const r2 = assetsR2Config();
  if (!r2 || !uploadConfig.cdnBaseUrl) {
    return errorJson(
      503,
      "Asset storage is not configured: set the R2_* variables and ASSET_CDN_BASE_URL.",
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorJson(400, "Expected a multipart/form-data body.");
  }

  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return errorJson(400, "Missing `file` field.");
  }
  const filename = file instanceof File ? file.name : "upload";

  if (file.size > MAX_UPLOAD_BYTES) {
    return errorJson(
      413,
      `File too large: ${file.size} bytes (max ${MAX_UPLOAD_BYTES}).`,
    );
  }

  const mime = resolveUploadMime(file.type, filename);
  if (!mime) {
    return errorJson(
      415,
      "Unsupported file type: accepted are jpeg, png, webp, heic.",
    );
  }

  let metadata: AssetMetadataInput;
  try {
    metadata = readAssetMetadataForm(form);
  } catch (err) {
    return errorJson(400, err instanceof Error ? err.message : "Invalid metadata.");
  }
  const onSimilarRaw = form.get("on_similar");
  const onSimilar = typeof onSimilarRaw === "string" ? onSimilarRaw : "accept";
  if (onSimilar !== "accept" && onSimilar !== "reject") {
    return errorJson(400, "Invalid `on_similar`: must be `accept` or `reject`.");
  }
  // Opt-in: strip on-screen text / captions / Instagram chrome before storing.
  const cleanup = form.get("remove_chrome") === "true";

  try {
    if (!(await manifestSupportsUploads())) {
      return errorJson(
        503,
        "The Manifest is missing the upload-path properties. Run `npm run setup:upload` first.",
      );
    }

    const original = Buffer.from(await file.arrayBuffer());

    // Decode (and transcode HEIC → JPEG, which browsers can't render). The
    // SHA-256 dedup fingerprint stays the *original* bytes (pre-transcode), so
    // re-uploading the same file under any name can never create a second asset.
    let stored = original;
    let storedMime = mime;
    let ext = ACCEPTED_TYPES[mime];
    if (ext === "heic") {
      try {
        const jpeg = await heicConvert({
          buffer: original,
          format: "JPEG",
          quality: 0.92,
        });
        stored = Buffer.from(jpeg);
        storedMime = "image/jpeg";
        ext = "jpg";
      } catch {
        return errorJson(415, "Could not decode the HEIC file.");
      }
    }

    const result = await ingestImage({
      sourceBytes: original,
      image: stored,
      storedMime,
      ext,
      filename,
      metadata,
      onSimilar,
      cleanup,
    });

    if (result.kind === "deduped") {
      return NextResponse.json({ deduped: true, asset: result.entry });
    }
    if (result.kind === "similar-rejected") {
      return NextResponse.json({ similar: result.similar }, { status: 409 });
    }
    return NextResponse.json(
      {
        ...result.entry,
        similar: result.similar,
        manifested: result.manifested,
        manifest: result.manifest,
      },
      { status: 201 },
    );
  } catch (err) {
    console.error("upload failed", err);
    const message = err instanceof Error ? err.message : "Upload failed";
    return errorJson(500, message);
  }
}

// GET /api/assets is not a listing endpoint (use /api/search); make that
// explicit rather than 405-ing without context.
export async function GET() {
  return errorJson(
    404,
    "Use GET /api/search to find assets, or GET /api/assets/{id} for one entry.",
  );
}
