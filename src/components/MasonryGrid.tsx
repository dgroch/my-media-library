"use client";

import type { Asset } from "@/lib/types";

import AssetCard from "./AssetCard";

interface Props {
  assets: Asset[];
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggle?: (id: string) => void;
}

export default function MasonryGrid({
  assets,
  selectable = false,
  selectedIds,
  onToggle,
}: Props) {
  return (
    <div className="masonry">
      {assets.map((asset) => (
        <AssetCard
          key={asset.id}
          asset={asset}
          selectable={selectable}
          selected={selectedIds?.has(asset.id) ?? false}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}
