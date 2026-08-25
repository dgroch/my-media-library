// Where the *original*, full-resolution file for an asset actually lives.
//
// The Manifest has two populations with opposite storage stories, and the UI
// has to send people to the right one or they end up with a small preview:
//
//   • Drive-synced rows (the ~12k crawled by the offline Drive skill): the
//     master lives in Google Drive and `Preview URL` is a *downscaled* CDN
//     preview generated from it (e.g. 640px wide for a 1080x1920 master).
//     The high-resolution file is only reachable via `Drive Link`.
//
//   • Uploaded rows (POST /api/assets): the exact bytes the uploader chose are
//     stored untouched under a content-addressed CDN key, so `url` *is* the
//     original. These have no Drive Link at all.
//
// So: prefer Drive when the row has it, else the CDN object. Client-safe (no
// `server-only`) because both the grid and the edit card need it.

import type { Asset } from "./types";

export type OriginalKind = "drive" | "cdn";

export interface OriginalSource {
  href: string;
  kind: OriginalKind;
  /** Where the file lives, for tooltips and labels. */
  where: string;
}

type AssetLike = Pick<Asset, "url" | "driveLink"> & { dimensions?: string };

/** The best available full-resolution source, or null when there is none. */
export function originalSource(asset: AssetLike): OriginalSource | null {
  if (asset.driveLink) {
    return { href: asset.driveLink, kind: "drive", where: "Google Drive" };
  }
  if (asset.url) {
    return { href: asset.url, kind: "cdn", where: "the brand CDN" };
  }
  return null;
}

/** "1080×1920" for display, or "" when the manifest doesn't record it. */
export function formatDimensions(dimensions?: string): string {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/.exec((dimensions ?? "").trim());
  return match ? `${match[1]}×${match[2]}` : "";
}

/**
 * True when what the grid renders is known to be smaller than the original —
 * i.e. a Drive master whose CDN preview we're showing instead. Used to label
 * the click-through so nobody assumes the preview is all there is.
 */
export function previewIsDownscaled(asset: AssetLike): boolean {
  return Boolean(asset.driveLink && asset.url);
}

/** Tooltip for the "open the original" affordance. */
export function originalTitle(asset: AssetLike): string {
  const source = originalSource(asset);
  if (!source) return "";
  const size = formatDimensions(asset.dimensions);
  const suffix = size ? ` (${size})` : "";
  return source.kind === "drive"
    ? `Open the full-resolution original on Google Drive${suffix}`
    : `Open the full-size original${suffix}`;
}
