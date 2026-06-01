"use client";

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
        <a
          className="open-link"
          href={asset.url}
          target="_blank"
          rel="noreferrer"
          title="Open full size"
          onClick={(e) => e.stopPropagation()}
        >
          ↗
        </a>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={asset.url} alt={asset.description || asset.title} loading="lazy" />
      <div className="card-caption">{asset.title}</div>
    </div>
  );
}
