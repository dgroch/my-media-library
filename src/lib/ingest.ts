import "server-only";

// The shared image-ingest core: dedup → near-dup advisory → store → AI manifest
// → index. Both the HTTP upload path (POST /api/assets) and the video frame
// pipeline funnel through here, so a frame extracted from a reel becomes an
// asset by exactly the same rules as a hand-uploaded photo (same SHA-256
// dedup, same pHash similarity, same Gemini enrichment).

import { createHash } from "node:crypto";

import sharp from "sharp";

import {
  assetSlug,
  createAssetEntry,
  embeddingTextForEntry,
  findAssetBySha256,
  mergeContribution,
  writeManifest,
  type AssetMetadataInput,
  type ManifestEntry,
} from "./assets";
import { geminiConfigured, uploadConfig } from "./config";
import { removeOverlays } from "./cleanup";
import { embedQuery } from "./embeddings";
import { manifestImage, type AssetManifest } from "./gemini";
import { hammingDistance, perceptualHash } from "./phash";
import { assetsR2Config, r2PutObject } from "./r2";
import { knownPhashCandidates, upsertRuntimeAsset } from "./searchIndex";

export interface SimilarHit {
  id: string;
  url: string;
  distance: number;
}

export type IngestResult =
  | {
      kind: "created";
      entry: ManifestEntry & { status: "ready" | "processing" };
      similar: SimilarHit[];
      manifested: boolean;
      manifest: AssetManifest | null;
    }
  | {
      kind: "deduped";
      entry: ManifestEntry & { status: "ready" | "processing" };
    }
  | { kind: "similar-rejected"; similar: SimilarHit[] };

export interface IngestParams {
  /** Bytes whose SHA-256 is the dedup fingerprint (the original upload). */
  sourceBytes: Buffer;
  /** The decoded image to store (post-HEIC-transcode, or a cleaned frame). */
  image: Buffer;
  storedMime: string;
  ext: string;
  filename: string;
  metadata: AssetMetadataInput;
  onSimilar: "accept" | "reject";
  /** Run Gemini manifesting (default true). */
  runManifest?: boolean;
  /** Strip on-screen text / captions / reel chrome before storing (Gemini). */
  cleanup?: boolean;
}

/**
 * Embed the entry and insert it into the runtime search index. Best-effort: a
 * transient embedding failure leaves the asset keyword-findable until re-index.
 */
async function indexEntry(entry: ManifestEntry): Promise<"ready" | "processing"> {
  let vector: number[] | null = null;
  try {
    vector = await embedQuery(embeddingTextForEntry(entry));
  } catch (err) {
    console.error("ingest: embedding failed, indexing keyword-only", err);
  }
  upsertRuntimeAsset(entry, vector);
  return vector ? "ready" : "processing";
}

/** Run the full ingest pipeline on one decoded image. */
export async function ingestImage(params: IngestParams): Promise<IngestResult> {
  const r2 = assetsR2Config();
  if (!r2 || !uploadConfig.cdnBaseUrl) {
    throw new Error(
      "Asset storage is not configured: set the R2_* variables and ASSET_CDN_BASE_URL.",
    );
  }

  // Layer 1 — exact dedup on the original bytes. A hit is a context
  // contribution: merge the metadata into the existing entry.
  const sha256 = createHash("sha256").update(params.sourceBytes).digest("hex");
  const existingPage = await findAssetBySha256(sha256);
  if (existingPage) {
    const merged = await mergeContribution(existingPage, params.metadata);
    const status = await indexEntry(merged);
    return { kind: "deduped", entry: { ...merged, status } };
  }

  try {
    await sharp(params.image).metadata();
  } catch {
    throw new Error("File does not decode as a supported image.");
  }

  // Optional cleanup: strip on-screen text / captions / reel chrome before the
  // image is fingerprinted and stored, so the stored asset (and its manifest)
  // is the clean version. Best-effort — returns the original if Gemini image
  // editing isn't configured or the call fails. Output is JPEG when it ran.
  let image = params.image;
  let storedMime = params.storedMime;
  let ext = params.ext;
  if (params.cleanup) {
    const cleaned = await removeOverlays(image, storedMime);
    if (cleaned !== image) {
      image = cleaned;
      storedMime = "image/jpeg";
      ext = "jpg";
    }
  }

  // Layer 2 — near-duplicate advisory across every known pHash.
  const phash = await perceptualHash(image);
  const similar: SimilarHit[] = knownPhashCandidates()
    .map((c) => ({ id: c.id, url: c.url, distance: hammingDistance(phash, c.phash) }))
    .filter((c) => c.distance <= uploadConfig.similarDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5);

  if (similar.length > 0 && params.onSimilar === "reject") {
    return { kind: "similar-rejected", similar };
  }

  // Store the original-resolution file under a content-addressed key.
  const slug = assetSlug(
    params.metadata.context ?? "",
    params.filename,
    ext,
    sha256,
  );
  const key = `${uploadConfig.storagePrefix}${slug}`;
  const put = await r2PutObject(r2, key, image, {
    contentType: storedMime,
    cacheControl: "public, max-age=31536000, immutable",
  });
  if (!put.ok) {
    const detail = await put.text().catch(() => "");
    console.error("ingest: R2 PUT failed", put.status, detail);
    throw new Error("Failed to store the file.");
  }

  const url = `${uploadConfig.cdnBaseUrl}/${slug}`;
  let entry = await createAssetEntry({
    filename: slug,
    url,
    mimeType: storedMime,
    sha256,
    phash,
    metadata: params.metadata,
  });

  // AI enrichment (best-effort) — never fails the ingest.
  let manifest: AssetManifest | null = null;
  if ((params.runManifest ?? true) && geminiConfigured()) {
    try {
      const meta = await sharp(image).metadata();
      manifest = await manifestImage({
        buffer: image,
        mimeType: storedMime,
        filename: slug,
        width: meta.width,
        height: meta.height,
      });
      entry = await writeManifest(entry.id, manifest);
    } catch (err) {
      console.error("ingest: manifesting failed", err);
      manifest = null;
    }
  }

  const status = await indexEntry(entry);
  return {
    kind: "created",
    entry: { ...entry, status },
    similar,
    manifested: Boolean(manifest),
    manifest,
  };
}

/**
 * Store a video original as an asset row. Videos aren't images, so there is no
 * pHash near-dup pass and no Gemini image manifest — just exact SHA-256 dedup,
 * a permanent CDN object, and a Manifest row (findable by its human context).
 */
export async function ingestVideoFile(params: {
  bytes: Buffer;
  storedMime: string;
  ext: string;
  filename: string;
  metadata: AssetMetadataInput;
}): Promise<IngestResult> {
  const r2 = assetsR2Config();
  if (!r2 || !uploadConfig.cdnBaseUrl) {
    throw new Error(
      "Asset storage is not configured: set the R2_* variables and ASSET_CDN_BASE_URL.",
    );
  }

  const sha256 = createHash("sha256").update(params.bytes).digest("hex");
  const existingPage = await findAssetBySha256(sha256);
  if (existingPage) {
    const merged = await mergeContribution(existingPage, params.metadata);
    const status = await indexEntry(merged);
    return { kind: "deduped", entry: { ...merged, status } };
  }

  const slug = assetSlug(
    params.metadata.context ?? "",
    params.filename,
    params.ext,
    sha256,
  );
  const put = await r2PutObject(r2, `${uploadConfig.storagePrefix}${slug}`, params.bytes, {
    contentType: params.storedMime,
    cacheControl: "public, max-age=31536000, immutable",
  });
  if (!put.ok) {
    const detail = await put.text().catch(() => "");
    console.error("ingest: video R2 PUT failed", put.status, detail);
    throw new Error("Failed to store the video.");
  }

  const entry = await createAssetEntry({
    filename: slug,
    url: `${uploadConfig.cdnBaseUrl}/${slug}`,
    mimeType: params.storedMime,
    sha256,
    phash: "",
    metadata: params.metadata,
  });
  const status = await indexEntry(entry);
  return { kind: "created", entry: { ...entry, status }, similar: [], manifested: false, manifest: null };
}
