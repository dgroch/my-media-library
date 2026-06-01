// Centralised, server-only configuration. Reads from environment variables
// with sensible defaults that match the current Brand Asset Manifest schema.

export const notionConfig = {
  token: process.env.NOTION_TOKEN ?? "",

  // Assets ("Brand Asset Manifest")
  assetsDatabaseId:
    process.env.NOTION_ASSETS_DATABASE_ID ??
    "357fdc24-425f-81ed-805c-c4f9aff0665f",
  // Optional explicit data source id. When empty we resolve it from the
  // database id at runtime (and cache it).
  assetsDataSourceId: process.env.NOTION_ASSETS_DATA_SOURCE_ID ?? "",

  // Collections (created via `npm run setup:collections`)
  collectionsDatabaseId: process.env.NOTION_COLLECTIONS_DATABASE_ID ?? "",
  collectionsDataSourceId: process.env.NOTION_COLLECTIONS_DATA_SOURCE_ID ?? "",
  collectionsParentPageId:
    process.env.NOTION_COLLECTIONS_PARENT_PAGE_ID ??
    "352fdc24-425f-8088-930c-c5c1ff6afa95",
} as const;

// Property names in the Manifest data source. Override via env if the schema
// changes. Keep these in one place so the rest of the app never hardcodes a
// Notion property name.
export const props = {
  title: process.env.NOTION_PROP_TITLE ?? "Asset",
  imageUrl: process.env.NOTION_PROP_IMAGE_URL ?? "Preview URL",
  description: process.env.NOTION_PROP_DESCRIPTION ?? "Overall Description",
  assetType: process.env.NOTION_PROP_ASSET_TYPE ?? "Asset Type",
  mimeType: process.env.NOTION_PROP_MIME_TYPE ?? "Mime Type",
  driveLink: process.env.NOTION_PROP_DRIVE_LINK ?? "Drive Link",
} as const;

// All the descriptive text properties that carry meaning from the manifest
// process. These are concatenated into a single document per asset and fed to
// the embedding model. The label is included so the model gets light structure.
export const embeddingTextProps: Array<{ label: string; name: string }> = [
  { label: "Description", name: "Overall Description" },
  { label: "Tags", name: "Visual Tags" },
  { label: "Products", name: "Products / Flowers" },
  { label: "Product name", name: "Product Name" },
  { label: "Content type", name: "Content Type" },
  { label: "Mood", name: "Mood Tone" },
  { label: "Setting", name: "Setting / Location" },
  { label: "People", name: "People Present" },
  { label: "Usable for", name: "Usable For" },
  { label: "Scene beats", name: "Timestamp Beats" },
  { label: "Notes", name: "Reorg Notes" },
];

// Used only by the (degraded) Notion substring fallback when no embedding
// index is available.
export const searchableTextProps = embeddingTextProps
  .map((p) => p.name)
  // The Notion "contains" filter only works on text-like properties; all of
  // the above are rich_text in the current schema.
  .filter(Boolean);

// The relation property on the Collections database that links to assets.
export const COLLECTION_ASSETS_PROP = "Assets";
export const COLLECTION_NAME_PROP = "Name";

// ---------------------------------------------------------------------------
// Semantic search (embeddings)
// ---------------------------------------------------------------------------
export const embeddingConfig = {
  apiKey: process.env.OPENAI_API_KEY ?? "",
  baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  model: process.env.EMBEDDING_MODEL ?? "text-embedding-3-small",
  // Reduced dimensions keep the on-disk index small and search fast with only
  // a marginal quality cost. `text-embedding-3-*` supports the `dimensions`
  // parameter natively.
  dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? "512"),
} as const;

// Where `npm run build:index` writes the prebuilt index and where the running
// app reads it from. Relative to the project working directory.
export const ASSET_INDEX_PATH =
  process.env.ASSET_INDEX_PATH ?? "data/asset-index.json";

