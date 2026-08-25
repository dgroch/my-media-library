import "server-only";

// The shared image-ingest core: dedup → near-dup advisory → store → AI manifest
// → index. Both the HTTP upload path (POST /api/assets) and the video frame
// pipeline funnel through here, so a frame extracted from a reel becomes an
// asset by exactly the same rules as a hand-uploaded photo (same SHA-256
// dedup, same pHash similarity, same Gemini enrichment).

import { createHash } from "node:crypto";

import sharp from "sharp";

import {
  archiveAsset,
  assetSlug,
  createAssetEntry,
  embeddingTextForEntry,
  findAssetBySha256,
  mergeContribution,
  pageToManifestEntry,
  writeManifest,
  writeStoredDimensions,
  type AssetMetadataInput,
  type ManifestEntry,
} from "./assets";
import { geminiConfigured, uploadConfig } from "./config";
import { removeOverlays } from "./cleanup";
import { mirrorToDrive } from "./drive";
import { embedQuery } from "./embeddings";
import { manifestImage, type AssetManifest } from "./gemini";
import { hammingDistance, perceptualHash } from "./phash";
import { assetsR2Config, r2DeleteObject, r2PutObject } from "./r2";
import {
  isSearchable,
  knownPhashCandidates,
  removeRuntimeAsset,
  upsertRuntimeAsset,
} from "./searchIndex";

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
      /** True when generative overlay removal actually changed the image. */
      cleaned: boolean;
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
  let cleaned = false;
  if (params.cleanup) {
    const result = await removeOverlays(image, storedMime);
    if (result !== image) {
      image = result;
      storedMime = "image/jpeg";
      ext = "jpg";
      cleaned = true;
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
  // The object above IS the original — nothing in this path downscales — so
  // its pixel size is what "open the original" leads to. Recorded on the row
  // for the UI; a metadata read that fails must not fail the upload.
  const stored = await sharp(image)
    .metadata()
    .catch(() => null);

  // Mirror the original to Drive so app uploads are browsable alongside the
  // legacy Drive-synced corpus. Best-effort by construction: the CDN object
  // above is already the original, so a Drive failure costs a backup, not the
  // asset, and returns null rather than throwing.
  const drive = await mirrorToDrive({
    name: slug,
    mimeType: storedMime,
    bytes: image,
  });

  let entry = await createAssetEntry({
    filename: slug,
    url,
    mimeType: storedMime,
    sha256,
    phash,
    metadata: params.metadata,
    width: stored?.width,
    height: stored?.height,
    drive,
  });

  // AI enrichment (best-effort) — never fails the ingest.
  let manifest: AssetManifest | null = null;
  if ((params.runManifest ?? true) && geminiConfigured()) {
    try {
      manifest = await manifestImage({
        buffer: image,
        mimeType: storedMime,
        filename: slug,
        width: stored?.width,
        height: stored?.height,
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
    cleaned,
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

  const drive = await mirrorToDrive({
    name: slug,
    mimeType: params.storedMime,
    bytes: params.bytes,
  });
  const entry = await createAssetEntry({
    filename: slug,
    url: `${uploadConfig.cdnBaseUrl}/${slug}`,
    mimeType: params.storedMime,
    sha256,
    phash: "",
    metadata: params.metadata,
    drive,
  });
  const status = await indexEntry(entry);
  return {
    kind: "created",
    entry: { ...entry, status },
    similar: [],
    manifested: false,
    manifest: null,
    cleaned: false,
  };
}

// ---------------------------------------------------------------------------
// After-the-fact maintenance: re-clean and delete an existing asset.
// ---------------------------------------------------------------------------

type EntryWithStatus = ManifestEntry & { status: "ready" | "processing" };

/** The R2 object key behind an asset's CDN url, or null if it isn't ours. */
function r2KeyForUrl(url: string): string | null {
  const base = uploadConfig.cdnBaseUrl;
  if (!base) return null;
  const prefixUrl = `${base}/`;
  if (!url.startsWith(prefixUrl)) return null;
  const slug = url.slice(prefixUrl.length);
  return slug ? `${uploadConfig.storagePrefix}${slug}` : null;
}

function withStatus(entry: ManifestEntry): EntryWithStatus {
  return { ...entry, status: isSearchable(entry.id) ? "ready" : "processing" };
}

/**
 * Re-run overlay removal on an already-stored asset. Fetches the current bytes
 * from the CDN, strips captions/chrome, overwrites the same object key (so the
 * URL is unchanged), then re-manifests + re-embeds so the description reflects
 * the cleaned image. Returns `cleaned: false` (a no-op) when Gemini image
 * editing isn't available or made no change.
 */
export async function recleanAsset(
  page: any,
): Promise<{ cleaned: boolean; entry: EntryWithStatus }> {
  const entry = pageToManifestEntry(page);
  const r2 = assetsR2Config();
  if (!r2 || !uploadConfig.cdnBaseUrl) {
    throw new Error("Asset storage is not configured.");
  }
  const key = r2KeyForUrl(entry.url);
  if (!key) {
    throw new Error("This asset has no managed CDN object to clean.");
  }

  const res = await fetch(entry.url);
  if (!res.ok) {
    throw new Error(`Could not fetch the stored image (${res.status}).`);
  }
  const original = Buffer.from(await res.arrayBuffer());

  const cleaned = await removeOverlays(original, "image/jpeg");
  if (cleaned === original) {
    // Not configured, failed, or no change — surfaced to the caller as a no-op.
    return { cleaned: false, entry: withStatus(entry) };
  }

  const put = await r2PutObject(r2, key, cleaned, {
    contentType: "image/jpeg",
    cacheControl: "public, max-age=31536000, immutable",
  });
  if (!put.ok) {
    const detail = await put.text().catch(() => "");
    console.error("reclean: R2 PUT failed", put.status, detail);
    throw new Error("Failed to store the cleaned image.");
  }

  // The stored file just changed size — the image model returns roughly 1MP
  // whatever it is given — so correct the recorded dimensions. Without this the
  // UI keeps advertising the pre-clean resolution for a file that no longer
  // has it.
  const cleanedMeta = await sharp(cleaned)
    .metadata()
    .catch(() => null);
  try {
    await writeStoredDimensions(entry.id, cleanedMeta?.width, cleanedMeta?.height);
  } catch (err) {
    console.error("reclean: recording dimensions failed", err);
  }

  // Re-manifest on the cleaned image (best-effort) so the AI description no
  // longer narrates the removed overlay text.
  let updated = entry;
  if (geminiConfigured()) {
    try {
      const manifest = await manifestImage({
        buffer: cleaned,
        mimeType: "image/jpeg",
        filename: entry.title,
        width: cleanedMeta?.width,
        height: cleanedMeta?.height,
      });
      updated = await writeManifest(entry.id, manifest);
    } catch (err) {
      console.error("reclean: manifesting failed", err);
    }
  }
  // Carry the corrected size on the returned entry too: without Gemini,
  // `updated` is the pre-clean read and would re-index the stale dimensions.
  if (cleanedMeta?.width && cleanedMeta?.height) {
    updated = {
      ...updated,
      dimensions: `${cleanedMeta.width}x${cleanedMeta.height}`,
    };
  }
  const status = await indexEntry(updated);
  return { cleaned: true, entry: { ...updated, status } };
}

/** Delete an asset: archive its Notion row, tombstone it out of search, and
 *  best-effort remove its CDN object. */
export async function deleteAsset(page: any): Promise<void> {
  const entry = pageToManifestEntry(page);
  await archiveAsset(entry.id);
  removeRuntimeAsset(entry.id);

  const r2 = assetsR2Config();
  const key = r2KeyForUrl(entry.url);
  if (r2 && key) {
    try {
      const res = await r2DeleteObject(r2, key);
      if (!res.ok && res.status !== 404) {
        console.error("delete: R2 delete failed", res.status);
      }
    } catch (err) {
      console.error("delete: R2 delete error", err);
    }
  }
}
