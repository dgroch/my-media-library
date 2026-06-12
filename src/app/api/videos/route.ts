import { NextResponse } from "next/server";

import {
  ACCEPTED_VIDEO_TYPES,
  MAX_VIDEO_BYTES,
  manifestSupportsUploads,
  readAssetMetadataForm,
  resolveVideoMime,
  type AssetMetadataInput,
} from "@/lib/assets";
import { checkAssetWriteAuth } from "@/lib/auth";
import { uploadConfig } from "@/lib/config";
import { ingestVideoFile } from "@/lib/ingest";
import { assetsR2Config } from "@/lib/r2";
import { startFrameJob } from "@/lib/videoJobs";

export const dynamic = "force-dynamic";

function errorJson(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

/**
 * Video upload. The client picks how to ingest:
 *   - `video`  — store the clip as a single asset (no frame work).
 *   - `frames` — kick off the extraction pipeline (unique scenes → best shot →
 *     cleanup → one asset per scene) and return a job id to poll.
 */
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
  if (!(file instanceof Blob)) return errorJson(400, "Missing `file` field.");
  const filename = file instanceof File ? file.name : "video";

  if (file.size > MAX_VIDEO_BYTES) {
    return errorJson(
      413,
      `Video too large: ${file.size} bytes (max ${MAX_VIDEO_BYTES}).`,
    );
  }

  const mime = resolveVideoMime(file.type, filename);
  if (!mime) {
    return errorJson(
      415,
      "Unsupported video type: accepted are mp4, mov, m4v, webm, mkv.",
    );
  }

  const choiceRaw = form.get("choice");
  const choice = typeof choiceRaw === "string" ? choiceRaw : "frames";
  if (choice !== "frames" && choice !== "video") {
    return errorJson(400, "Invalid `choice`: must be `frames` or `video`.");
  }

  const onSimilarRaw = form.get("on_similar");
  const onSimilar = typeof onSimilarRaw === "string" ? onSimilarRaw : "accept";
  if (onSimilar !== "accept" && onSimilar !== "reject") {
    return errorJson(400, "Invalid `on_similar`: must be `accept` or `reject`.");
  }
  const removeChrome = form.get("remove_chrome") !== "false";

  let metadata: AssetMetadataInput;
  try {
    metadata = readAssetMetadataForm(form);
  } catch (err) {
    return errorJson(400, err instanceof Error ? err.message : "Invalid metadata.");
  }

  try {
    if (!(await manifestSupportsUploads())) {
      return errorJson(
        503,
        "The Manifest is missing the upload-path properties. Run `npm run setup:upload` first.",
      );
    }

    const ext = ACCEPTED_VIDEO_TYPES[mime];
    const bytes = Buffer.from(await file.arrayBuffer());

    if (choice === "video") {
      const result = await ingestVideoFile({
        bytes,
        storedMime: mime,
        ext,
        filename,
        metadata,
      });
      if (result.kind === "deduped") {
        return NextResponse.json({ deduped: true, asset: result.entry });
      }
      if (result.kind === "created") {
        return NextResponse.json({ choice, asset: result.entry }, { status: 201 });
      }
      return errorJson(500, "Unexpected ingest result.");
    }

    const jobId = startFrameJob({
      videoBuffer: bytes,
      ext,
      filename,
      metadata,
      onSimilar,
      removeChrome,
    });
    return NextResponse.json({ choice, jobId }, { status: 202 });
  } catch (err) {
    console.error("video upload failed", err);
    const message = err instanceof Error ? err.message : "Video upload failed";
    return errorJson(500, message);
  }
}
