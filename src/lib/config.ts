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

// AI-channel properties on the Manifest — the enrichment side of the two-channel
// rule. These are written by the manifesting pipeline (Gemini vision at upload,
// or the offline Drive crawler skill) and NEVER by the human path. Names default
// to the live "Brand Asset Manifest" schema; override via env if it changes.
// Writes are schema-adaptive (see buildProperties), so a property missing from
// the data source is silently skipped rather than erroring.
export const aiProps = {
  description: process.env.NOTION_PROP_DESCRIPTION ?? "Overall Description",
  contentType: process.env.NOTION_PROP_CONTENT_TYPE ?? "Content Type",
  moodTone: process.env.NOTION_PROP_MOOD_TONE ?? "Mood Tone",
  visualTags: process.env.NOTION_PROP_VISUAL_TAGS ?? "Visual Tags",
  peoplePresent: process.env.NOTION_PROP_PEOPLE_PRESENT ?? "People Present",
  productsFlowers: process.env.NOTION_PROP_PRODUCTS_FLOWERS ?? "Products / Flowers",
  settingLocation: process.env.NOTION_PROP_SETTING_LOCATION ?? "Setting / Location",
  usableFor: process.env.NOTION_PROP_USABLE_FOR ?? "Usable For",
  reorgNotes: process.env.NOTION_PROP_REORG_NOTES ?? "Reorg Notes",
  timestampBeats: process.env.NOTION_PROP_TIMESTAMP_BEATS ?? "Timestamp Beats",
  containsProduct: process.env.NOTION_PROP_CONTAINS_PRODUCT ?? "Contains Product",
  productName: process.env.NOTION_PROP_PRODUCT_NAME ?? "Product Name",
  productConfidence:
    process.env.NOTION_PROP_PRODUCT_CONFIDENCE ?? "Product Match Confidence",
} as const;

// All the descriptive text properties that carry meaning from the manifest
// process. These are concatenated into a single document per asset and fed to
// the embedding model. The label is included so the model gets light structure.
// `type` reflects the Notion property type — it matters for the keyword
// fallback, where the filter shape differs between rich_text and select.
type PropType = "rich_text" | "select";
export const embeddingTextProps: Array<{
  label: string;
  name: string;
  type: PropType;
}> = [
  { label: "Description", name: "Overall Description", type: "rich_text" },
  { label: "Tags", name: "Visual Tags", type: "rich_text" },
  { label: "Products", name: "Products / Flowers", type: "rich_text" },
  { label: "Product name", name: "Product Name", type: "rich_text" },
  { label: "Content type", name: "Content Type", type: "select" },
  { label: "Mood", name: "Mood Tone", type: "rich_text" },
  { label: "Setting", name: "Setting / Location", type: "rich_text" },
  { label: "People", name: "People Present", type: "rich_text" },
  { label: "Usable for", name: "Usable For", type: "rich_text" },
  { label: "Scene beats", name: "Timestamp Beats", type: "rich_text" },
  { label: "Notes", name: "Reorg Notes", type: "rich_text" },
];

// Used only by the (degraded) Notion substring fallback when no embedding
// index is available. Notion's `contains` text filter only works on rich_text
// properties, so select properties (e.g. "Content Type") are excluded here.
export const keywordTextProps = embeddingTextProps
  .filter((p) => p.type === "rich_text")
  .map((p) => p.name);


// Human-context properties on the Manifest (the upload path's metadata
// channel). These are authored by people — at upload or via PATCH backfill —
// and are NEVER written by the AI enrichment pipeline. Created by
// `npm run setup:upload`. Override names via env if the schema changes.
export const humanProps = {
  context: process.env.NOTION_PROP_CONTEXT ?? "Context",
  people: process.env.NOTION_PROP_PEOPLE ?? "People",
  product: process.env.NOTION_PROP_PRODUCT ?? "Product",
  location: process.env.NOTION_PROP_LOCATION ?? "Location",
  shoot: process.env.NOTION_PROP_SHOOT ?? "Shoot",
  credit: process.env.NOTION_PROP_CREDIT ?? "Credit",
  rights: process.env.NOTION_PROP_RIGHTS ?? "Rights",
  rightsNotes: process.env.NOTION_PROP_RIGHTS_NOTES ?? "Rights Notes",
  tags: process.env.NOTION_PROP_TAGS ?? "Tags",
  source: process.env.NOTION_PROP_SOURCE ?? "Source",
  uploadedBy: process.env.NOTION_PROP_UPLOADED_BY ?? "Uploaded By",
  uploadedAt: process.env.NOTION_PROP_UPLOADED_AT ?? "Uploaded At",
  sha256: process.env.NOTION_PROP_SHA256 ?? "SHA256",
  phash: process.env.NOTION_PROP_PHASH ?? "pHash",
} as const;

// Human-channel rich_text properties also searched by the keyword fallback
// (filtered against the live schema at query time, since they only exist
// after `npm run setup:upload`).
export const humanKeywordProps: string[] = [
  humanProps.context,
  humanProps.people,
  humanProps.product,
  humanProps.location,
  humanProps.shoot,
];

// ---------------------------------------------------------------------------
// Upload path (POST /api/assets)
// ---------------------------------------------------------------------------
export const uploadConfig = {
  // Bearer token required on POST /api/assets and PATCH /api/assets/:id.
  // Uploads are disabled (503) until this is set — unlike collections, asset
  // writes are never open, because they create permanent CDN objects.
  token: process.env.ASSET_LIBRARY_TOKEN ?? "",
  // Public base URL the brand CDN serves uploaded originals from, e.g.
  // https://cdn.example.com/figandbloom/asset-manifest (no trailing slash).
  cdnBaseUrl: (process.env.ASSET_CDN_BASE_URL ?? "").replace(/\/+$/, ""),
  // R2 object key prefix for uploaded originals. Matches the stable CDN path
  // so content-addressed URLs never expire (unlike manifest/previews/...).
  storagePrefix:
    process.env.ASSET_STORAGE_PREFIX ?? "figandbloom/asset-manifest/",
  // Bucket for uploaded originals; defaults to the index bucket.
  bucket: process.env.ASSET_R2_BUCKET ?? process.env.R2_BUCKET ?? "",
  maxBytes: Number(process.env.ASSET_MAX_BYTES ?? 25 * 1024 * 1024),
  // Video uploads are read fully into memory for frame extraction, so keep the
  // cap modest on small instances. Reels are typically well under this.
  maxVideoBytes: Number(process.env.ASSET_MAX_VIDEO_BYTES ?? 100 * 1024 * 1024),
  // pHash Hamming distance at or under which two images count as "similar".
  similarDistance: Number(process.env.ASSET_SIMILAR_DISTANCE ?? "6"),
  // Derived objects (render cache etc.): a separate CDN namespace, outside
  // the manifest — never indexed, deduped or enriched. See PUT /api/derived.
  derivedPrefix: process.env.ASSET_DERIVED_PREFIX ?? "derived/",
  // Optional public base URL the CDN serves the derived prefix from, e.g.
  // https://cdn.example.com/derived (no trailing slash). When set, PUT
  // responses include the public `url`.
  derivedCdnBaseUrl: (process.env.ASSET_DERIVED_CDN_BASE_URL ?? "").replace(
    /\/+$/,
    "",
  ),
} as const;

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

// ---------------------------------------------------------------------------
// Gemini vision manifesting (POST /api/assets enrichment)
// ---------------------------------------------------------------------------
// Mirrors the brand-asset-manifesting skill: analyse the uploaded image with a
// Gemini vision model and fill the AI channel (Overall Description, Visual Tags,
// …). Two providers are supported — Google's native Generative Language API
// (default) and OpenRouter — so this matches whichever key the org already has.
// Manifesting is best-effort: when no key is configured (or a call fails) the
// upload still succeeds, just without AI enrichment.
type GeminiProvider = "google" | "openrouter";

const geminiProvider = (
  process.env.GEMINI_PROVIDER ?? "google"
).toLowerCase() as GeminiProvider;

export const geminiConfig = {
  provider: geminiProvider,
  // Google native: GEMINI_API_KEY or GOOGLE_API_KEY. OpenRouter: OPENROUTER_API_KEY.
  apiKey:
    geminiProvider === "openrouter"
      ? process.env.OPENROUTER_API_KEY ?? ""
      : process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "",
  // Defaults follow the manifesting skill: gemini-2.5-flash on Google native,
  // google/gemini-3-flash-preview on OpenRouter.
  model:
    process.env.GEMINI_MODEL ??
    (geminiProvider === "openrouter"
      ? "google/gemini-3-flash-preview"
      : "gemini-2.5-flash"),
  googleBaseUrl: (
    process.env.GEMINI_GOOGLE_BASE_URL ??
    "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/+$/, ""),
  openrouterBaseUrl: (
    process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1"
  ).replace(/\/+$/, ""),
  // When true, ask the model to also classify the catalogue product (a review
  // suggestion — the human Product field stays canonical).
  productClassification:
    (process.env.PRODUCT_CLASSIFICATION_ENABLED ?? "true").toLowerCase() !==
    "false",
} as const;

export function geminiConfigured(): boolean {
  return Boolean(geminiConfig.apiKey);
}

// Generative image editing (frame cleanup — removing OSTs / reel chrome via
// inpainting). Uses Gemini's image model on the Google-native API; an
// OpenRouter text key can't drive it, so overlay removal is skipped there and
// cleanup falls back to the conservative sharp adjustments.
export const geminiImageConfig = {
  model: process.env.GEMINI_IMAGE_MODEL ?? "gemini-2.5-flash-image",
  // Editing needs a Google-native key regardless of GEMINI_PROVIDER.
  apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "",
} as const;

export function geminiImageEditConfigured(): boolean {
  return Boolean(geminiImageConfig.apiKey);
}

// Where `npm run build:index` writes the prebuilt index. It lives under src/
// so it is bundled into the build via a static import (see searchIndex.ts) —
// this avoids relying on build-time files surviving to runtime on the host.
export const ASSET_INDEX_PATH =
  process.env.ASSET_INDEX_PATH ?? "src/data/asset-index.json";

