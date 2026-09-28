// Shared shapes used across the API, server components and client components.

import type { MediaType } from "./media";
import type { CollectionCriteria } from "./collectionCriteria";

/** How a collection decides its members. */
export type CollectionKind = "manual" | "smart";

export interface Asset {
  /** Notion page id of the asset row. */
  id: string;
  /** Human title (the `Asset` filename property). */
  title: string;
  /**
   * CDN image URL (the `Preview URL` property). May be empty — videos and some
   * rows have no public preview, in which case the UI shows a placeholder.
   */
  url: string;
  /** Long-form description, used as tooltip / alt text. */
  description: string;
  /** Derived from the filename/MIME — "image" | "video" | "other". */
  mediaType: MediaType;
  /**
   * Google Drive link to the original file. When set, the master lives in
   * Drive and `url` is a downscaled CDN preview of it — see `originalSource`
   * in `lib/original.ts`, which is how the UI decides where "open the
   * original" points.
   */
  driveLink: string;
  /**
   * Pixel size of the *original* as "WxH" (the Manifest's `Dimensions`), or
   * "" when unknown. Note this describes the original, not the preview.
   */
  dimensions: string;
  /**
   * True when `url` is itself the untouched original — i.e. the row was
   * uploaded through this app, which never downscales. False for
   * Drive-synced rows, where `url` is a downscaled preview of the Drive
   * master. Uploads are also mirrored to Drive, so `driveLink` alone can no
   * longer tell the two apart.
   */
  cdnIsOriginal: boolean;
}

export interface SearchResponse {
  results: Asset[];
  /** Opaque cursor for the next page, or null when there are no more results. */
  nextCursor: string | null;
}

export interface Collection {
  id: string;
  name: string;
  items: Asset[];
  /**
   * "manual" collections hold a fixed relation list; "smart" ones re-evaluate
   * their stored rule on every read, so members appear and disappear as the
   * Manifest changes. Rows created before the feature has no `Type` value and
   * are read as "manual".
   */
  kind: CollectionKind;
  /** The rule, for smart collections only. */
  criteria: CollectionCriteria | null;
  /**
   * Human-readable rendering of `criteria` (e.g. `Tags has all of "a", "b"`).
   * Computed server-side so the client never needs the property-name config,
   * and so it matches what Notion shows in `Rule Summary`.
   */
  summary: string;
  /**
   * True when a smart rule matched more assets than the per-view cap, so
   * `items` is a prefix rather than the whole set.
   */
  truncated: boolean;
  /**
   * Why a smart rule could not be evaluated (e.g. a tag was renamed or deleted
   * in Notion), so the UI can explain an empty view. Null when it evaluated.
   */
  evaluationError: string | null;
}

/** Lightweight collection metadata for list/index views (no asset rows). */
export interface CollectionSummary {
  id: string;
  name: string;
  kind: CollectionKind;
  /** Number of linked assets. Capped/partial when `partialCount` is true. */
  assetCount: number;
  /** True when the real count exceeds what a single query page returned. */
  partialCount: boolean;
  /** ISO timestamp the collection row was created in Notion. */
  createdTime: string;
}
