// Shared shapes used across the API, server components and client components.

import type { MediaType } from "./media";

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
  /** Google Drive link to the original file (fallback when there is no CDN url). */
  driveLink: string;
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
}
