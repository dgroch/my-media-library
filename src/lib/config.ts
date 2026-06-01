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
} as const;

// Rich-text / title properties that a free-text query is matched against.
// (Select / number / url properties are intentionally excluded because the
// Notion "contains" filter only applies to text-like properties.)
export const searchableTextProps = [
  "Overall Description",
  "Visual Tags",
  "Products / Flowers",
  "Mood Tone",
  "Setting / Location",
  "Usable For",
  "People Present",
  "Product Name",
] as const;

// The relation property on the Collections database that links to assets.
export const COLLECTION_ASSETS_PROP = "Assets";
export const COLLECTION_NAME_PROP = "Name";
