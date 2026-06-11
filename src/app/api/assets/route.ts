import { createHash } from "node:crypto";

import heicConvert from "heic-convert";
import { NextResponse } from "next/server";
import sharp from "sharp";

import {
  ACCEPTED_TYPES,
  MAX_UPLOAD_BYTES,
  assetSlug,
  createAssetEntry,
  embeddingTextForEntry,
  findAssetBySha256,
  manifestSupportsUploads,
  mergeContribution,
  parsePeopleField,
  parseRightsKind,
  parseTagsField,
  resolveUploadMime,
  type AssetMetadataInput,
  type ManifestEntry,
} from "@/lib/assets";
import { checkAssetWriteAuth } from "@/lib/auth";
import { uploadConfig } from "@/lib/config";
import { embedQuery } from "@/lib/embeddings";
import { hammingDistance, perceptualHash } from "@/lib/phash";
import { assetsR2Config, r2PutObject } from "@/lib/r2";
import { knownPhashCandidates, upsertRuntimeAsset } from "@/lib/searchIndex";

export const dynamic = "force-dynamic";

interface SimilarHit {
  id: string;
  url: string;
  distance: number;
}

function errorJson(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

/**
 * Embed the entry's human-context-first text and insert it into the runtime
 * search index. Best-effort: a transient embedding failure must not fail the
 * upload — the asset stays findable by direct keyword match until re-index.
 * Returns the entry's search status.
 */
async function indexEntry(entry: ManifestEntry): Promise<"ready" | "processing"> {
  let vector: number[] | null = null;
  try {
    vector = await embedQuery(embeddingTextForEntry(entry));
  } catch (err) {
    console.error("upload: embedding failed, indexing keyword-only", err);
  }
  upsertRuntimeAsset(entry, vector);
  return vector ? "ready" : "processing";
}

/** Collect optional human-metadata fields from the multipart form. */
function readMetadata(form: FormData): AssetMetadataInput {
  const text = (name: string): string | undefined => {
    const v = form.get(name);
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };

  const metadata: AssetMetadataInput = {
    context: text("context"),
    product: text("product"),
    location: text("location"),
    shoot: text("shoot"),
    credit: text("credit"),
    source: text("source"),
    uploaded_by: text("uploaded_by"),
  };

  const people = text("people");
  if (people) metadata.people = parsePeopleField(people);

  const tags = text("tags");
  if (tags) metadata.tags = parseTagsField(tags);

  const rights = text("rights");
  if (rights) metadata.rights = { kind: parseRightsKind(rights) };

  return metadata;
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
    metadata = readMetadata(form);
  } catch (err) {
    return errorJson(400, err instanceof Error ? err.message : "Invalid metadata.");
  }
  const onSimilarRaw = form.get("on_similar");
  const onSimilar = typeof onSimilarRaw === "string" ? onSimilarRaw : "accept";
  if (onSimilar !== "accept" && onSimilar !== "reject") {
    return errorJson(400, "Invalid `on_similar`: must be `accept` or `reject`.");
  }

  try {
    if (!(await manifestSupportsUploads())) {
      return errorJson(
        503,
        "The Manifest is missing the upload-path properties. Run `npm run setup:upload` first.",
      );
    }

    const original = Buffer.from(await file.arrayBuffer());

    // Layer 1 — exact dedup, the hard guarantee. The fingerprint is the
    // SHA-256 of the *original* bytes (pre-transcode), so re-uploading the
    // same file under any name can never create a second asset. A hit is a
    // context contribution: merge the submitted metadata into the existing
    // entry and return it.
    const sha256 = createHash("sha256").update(original).digest("hex");
    const existingPage = await findAssetBySha256(sha256);
    if (existingPage) {
      const merged = await mergeContribution(existingPage, metadata);
      const status = await indexEntry(merged); // refresh with merged context
      return NextResponse.json({
        deduped: true,
        asset: { ...merged, status },
      });
    }

    // Decode (and transcode HEIC → JPEG, which browsers can't render).
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
    try {
      await sharp(stored).metadata();
    } catch {
      return errorJson(415, "File does not decode as a supported image.");
    }

    // Layer 2 — near-duplicate advisory. Compare against every known pHash
    // (prebuilt index + this process's uploads); re-exports, resizes, light
    // crops and format conversions land within the distance threshold.
    const phash = await perceptualHash(stored);
    const similar: SimilarHit[] = knownPhashCandidates()
      .map((c) => ({ id: c.id, url: c.url, distance: hammingDistance(phash, c.phash) }))
      .filter((c) => c.distance <= uploadConfig.similarDistance)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5);

    if (similar.length > 0 && onSimilar === "reject") {
      return NextResponse.json({ similar }, { status: 409 });
    }

    // Store the original-resolution file under a permanent, content-addressed
    // key. Immutable caching is safe because the slug embeds the content hash.
    const slug = assetSlug(metadata.context ?? "", filename, ext, sha256);
    const key = `${uploadConfig.storagePrefix}${slug}`;
    const put = await r2PutObject(r2, key, stored, {
      contentType: storedMime,
      cacheControl: "public, max-age=31536000, immutable",
    });
    if (!put.ok) {
      const detail = await put.text().catch(() => "");
      console.error("upload: R2 PUT failed", put.status, detail);
      return errorJson(502, "Failed to store the file.");
    }

    const url = `${uploadConfig.cdnBaseUrl}/${slug}`;
    const entry = await createAssetEntry({
      filename: slug,
      url,
      mimeType: storedMime,
      sha256,
      phash,
      metadata,
    });

    const status = await indexEntry(entry);
    return NextResponse.json(
      { ...entry, status, similar },
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
