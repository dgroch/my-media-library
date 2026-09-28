import type { Asset } from "./types";

/**
 * URL to render for an asset inside a grid tile.
 *
 * Only assets whose `url` is the untouched original need a rendition — those
 * are the app uploads (`cdnIsOriginal`), which are typically 2000x3000 at
 * ~3.2 MB each. Drive-synced rows already point at a downscaled preview, so
 * they keep using `url` and we do not add a hop for them.
 *
 * Assets with no SHA256 (rows predating the dedup column, and index entries
 * built before the field was recorded) also keep `url`: a heavier tile beats a
 * broken one.
 *
 * This is deliberately the *grid* rendition only. The asset detail page and the
 * "open the original" affordances are untouched and still serve full
 * resolution — that is where a person goes when they want the real file.
 */
export function thumbUrl(
  asset: Pick<Asset, "url" | "sha256" | "cdnIsOriginal" | "mediaType">,
): string {
  if (!asset.url) return asset.url;
  if (asset.mediaType !== "image") return asset.url;
  if (!asset.cdnIsOriginal) return asset.url;
  if (!asset.sha256) return asset.url;
  return `/api/thumb/${asset.sha256}`;
}
