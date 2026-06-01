// Pure helpers for classifying an asset's media type. Safe to import from both
// server and client code (no Node/Notion dependencies).

export type MediaType = "image" | "video" | "other";

const IMAGE_EXT = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "heic",
  "tiff",
  "bmp",
]);

const VIDEO_EXT = new Set([
  "mp4",
  "mov",
  "webm",
  "m4v",
  "avi",
  "mkv",
  "gifv",
]);

function extOf(filename: string): string {
  const m = /\.([a-z0-9]+)\s*$/i.exec(filename.trim());
  return m ? m[1].toLowerCase() : "";
}

/**
 * Determine the media type. We trust the filename extension first (it is the
 * most reliable signal in the Manifest), then fall back to the MIME type and
 * finally the (often unset) `Asset Type` property.
 */
export function detectMediaType(
  filename: string,
  mime = "",
  assetType = "",
): MediaType {
  const ext = extOf(filename);
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";

  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";

  const a = assetType.toLowerCase();
  if (a === "image" || a === "video") return a;

  return "other";
}
