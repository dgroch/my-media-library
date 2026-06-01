// Shared shapes used across the API, server components and client components.

export interface Asset {
  /** Notion page id of the asset row. */
  id: string;
  /** Human title (the `Asset` filename property). */
  title: string;
  /** CDN image URL (the `Preview URL` property). May be empty if missing. */
  url: string;
  /** Long-form description, used as tooltip / alt text. */
  description: string;
  /** "image" | "video" | "other" */
  assetType: string;
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
