"use client";

import Link from "next/link";

import {
  formatDimensions,
  originalSource,
  originalTitle,
  previewIsDownscaled,
} from "@/lib/original";
import type { Asset } from "@/lib/types";

interface Props {
  asset: Asset;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: (id: string) => void;
}

export default function AssetCard({
  asset,
  selectable = false,
  selected = false,
  onToggle,
}: Props) {
  const className = [
    "card",
    selectable ? "selectable" : "",
    selected ? "selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const isVideo = asset.mediaType === "video";
  const hasImage = Boolean(asset.url);
  // Where the "open" affordance points: the ORIGINAL, which for a Drive-synced
  // row is the Drive master — the CDN url on those rows is a downscaled
  // preview, so pointing here at `url` (as this once did) left everyone stuck
  // with the small version.
  const original = originalSource(asset);
  const size = formatDimensions(asset.dimensions);
  const downscaled = previewIsDownscaled(asset);

  return (
    <div
      className={className}
      onClick={selectable ? () => onToggle?.(asset.id) : undefined}
    >
      <div className="card-overlay">
        {selectable ? (
          <div className="check" aria-hidden>
            {selected ? "✓" : ""}
          </div>
        ) : (
          <span />
        )}
        <div className="card-actions">
          <Link
            className="open-link"
            href={`/a/${asset.id}`}
            title="Edit details / tag"
            onClick={(e) => e.stopPropagation()}
          >
            ✎
          </Link>
          {original && (
            <a
              className={`open-link${original.kind === "drive" ? " is-drive" : ""}`}
              href={original.href}
              target="_blank"
              rel="noreferrer"
              title={originalTitle(asset)}
              onClick={(e) => e.stopPropagation()}
            >
              ↗
            </a>
          )}
        </div>
      </div>

      {(isVideo || downscaled) && (
        <div className="badges">
          {isVideo && <span className="badge">▶ Video</span>}
          {/* Say so when the tile is a downscaled preview, so the
              higher-resolution original behind ↗ is discoverable rather than a
              hidden affordance. */}
          {downscaled && original && (
            <a
              className="badge badge-original"
              href={original.href}
              target="_blank"
              rel="noreferrer"
              title={originalTitle(asset)}
              onClick={(e) => e.stopPropagation()}
            >
              ⤢ Original on Drive{size ? ` · ${size}` : ""}
            </a>
          )}
        </div>
      )}

      {hasImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={asset.url}
          alt={asset.description || asset.title}
          loading="lazy"
        />
      ) : (
        <div className={`placeholder ${isVideo ? "is-video" : ""}`}>
          <div className="placeholder-glyph">{isVideo ? "▶" : "🖼"}</div>
          {asset.description && (
            <p className="placeholder-desc">{asset.description}</p>
          )}
        </div>
      )}

      <div className="card-caption">{asset.title}</div>
    </div>
  );
}
