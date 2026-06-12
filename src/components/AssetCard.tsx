"use client";

import Link from "next/link";

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
  // Where the "open" affordance points: CDN preview first, else the original.
  const openHref = asset.url || asset.driveLink || "";

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
          {openHref && (
            <a
              className="open-link"
              href={openHref}
              target="_blank"
              rel="noreferrer"
              title={isVideo ? "Open video" : "Open full size"}
              onClick={(e) => e.stopPropagation()}
            >
              ↗
            </a>
          )}
        </div>
      </div>

      {isVideo && <span className="badge">▶ Video</span>}

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
