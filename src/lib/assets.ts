import "server-only";

// The asset upload path's manifest layer: reading and writing Manifest rows
// with the human-context channel (context, people, product, …) alongside the
// AI channel (Overall Description etc.). Two-channel rule: everything in
// `humanProps` is human-authored — written here at upload / PATCH / dedup
// merge — and must never be touched by the AI enrichment pipeline. Where the
// channels disagree, the human one wins (it leads the embedding text and the
// CDN slug).

import { aiProps, humanProps, props, uploadConfig } from "./config";
import type { AssetManifest } from "./gemini";
import { detectMediaType, type MediaType } from "./media";
import {
  assetsDataSourceId,
  manifestSchema,
  notionClient,
  plainText,
} from "./notion";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface PersonTag {
  name: string;
  /** Consent to appear in published material, recorded per person. */
  consent?: boolean;
}

export const RIGHTS_KINDS = ["internal", "licensed", "restricted"] as const;
export type RightsKind = (typeof RIGHTS_KINDS)[number];

export interface RightsInfo {
  kind: RightsKind;
  notes: string;
}

/**
 * A full manifest entry as returned by the assets API. Field names follow the
 * upload-path spec (snake_case for the new fields, so consumers coded against
 * the spec work verbatim); the pre-existing search fields keep their
 * camelCase names.
 */
export interface ManifestEntry {
  id: string;
  title: string;
  /** Permanent CDN URL. */
  url: string;
  /** AI-classifier description (the enrichment channel). */
  description: string;
  mediaType: MediaType;
  driveLink: string;
  // Human channel ------------------------------------------------------------
  context: string;
  people: PersonTag[];
  product: string;
  location: string;
  shoot: string;
  credit: string;
  rights: RightsInfo;
  tags: string[];
  source: string;
  uploaded_by: string;
  uploaded_at: string;
  // Dedup fingerprints --------------------------------------------------------
  sha256: string;
  phash: string;
}

/** Metadata fields accepted by POST (alongside the file) and PATCH. */
export interface AssetMetadataInput {
  context?: string;
  people?: PersonTag[];
  product?: string;
  location?: string;
  shoot?: string;
  credit?: string;
  rights?: { kind?: RightsKind; notes?: string };
  tags?: string[];
  source?: string;
  uploaded_by?: string;
}

// ---------------------------------------------------------------------------
// Form-field parsing (multipart `people` / `tags` / `rights` arrive as text)
// ---------------------------------------------------------------------------

/** Validate a decoded `people` value. Throws with a caller-facing message. */
export function validatePeople(parsed: unknown): PersonTag[] {
  if (!Array.isArray(parsed)) {
    throw new Error(
      'Invalid `people`: must be a JSON array like [{"name":"Kellie","consent":true}].',
    );
  }
  return parsed.map((p: any) => {
    const name = typeof p?.name === "string" ? p.name.trim() : "";
    if (!name) {
      throw new Error("Invalid `people`: every entry needs a `name` string.");
    }
    const tag: PersonTag = { name };
    if (typeof p.consent === "boolean") tag.consent = p.consent;
    return tag;
  });
}

/** Parse the `people` multipart form field (a JSON string). */
export function parsePeopleField(raw: string): PersonTag[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'Invalid `people`: must be a JSON array like [{"name":"Kellie","consent":true}].',
    );
  }
  return validatePeople(parsed);
}

/** Validate a decoded `tags` value (array of non-empty strings). */
export function validateTags(parsed: unknown): string[] {
  if (
    !Array.isArray(parsed) ||
    parsed.some((t) => typeof t !== "string" || !t.trim())
  ) {
    throw new Error("Invalid `tags`: must be a JSON array of non-empty strings.");
  }
  return (parsed as string[]).map((t) => t.trim());
}

/** Parse the `tags` multipart form field (a JSON string). */
export function parseTagsField(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid `tags`: must be a JSON array like ["studio"].');
  }
  return validateTags(parsed);
}

export function parseRightsKind(raw: string): RightsKind {
  const kind = raw.trim().toLowerCase();
  if (!(RIGHTS_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `Invalid \`rights\`: must be one of ${RIGHTS_KINDS.join(" | ")}.`,
    );
  }
  return kind as RightsKind;
}

// ---------------------------------------------------------------------------
// Slug generation
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics (post-NFKD)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * CDN filename for an upload. Derived from the human context when present
 * (URLs become self-describing: kellie-tying-stems-melbourne-studio-1znua2.jpg),
 * falling back to the original filename. A short hash suffix from the content
 * sha256 keeps names unique and content-addressed.
 */
export function assetSlug(
  context: string,
  originalName: string,
  ext: string,
  sha256: string,
): string {
  let base =
    slugify(context) || slugify(originalName.replace(/\.[a-z0-9]+$/i, ""));
  if (base.length > 60) {
    base = base.slice(0, 60).replace(/-[^-]*$/, "");
  }
  if (!base) base = "asset";
  const suffix = BigInt(`0x${sha256.slice(0, 16)}`)
    .toString(36)
    .slice(0, 6);
  return `${base}-${suffix}.${ext}`;
}

// ---------------------------------------------------------------------------
// Embedding text — human context first, AI description second, so the human
// channel dominates similarity (the "Kellie problem").
// ---------------------------------------------------------------------------

export function embeddingTextForEntry(entry: ManifestEntry): string {
  const lines = [entry.title];
  if (entry.context) lines.push(`Context: ${entry.context}`);
  const names = entry.people.map((p) => p.name).filter(Boolean);
  if (names.length) lines.push(`People: ${names.join(", ")}`);
  if (entry.product) lines.push(`Product: ${entry.product}`);
  if (entry.location) lines.push(`Location: ${entry.location}`);
  if (entry.shoot) lines.push(`Shoot: ${entry.shoot}`);
  if (entry.tags.length) lines.push(`Tags: ${entry.tags.join(", ")}`);
  if (entry.description) lines.push(`Description: ${entry.description}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Manifest writes — adapt to the actual Notion property types (via the cached
// schema in notion.ts) so a renamed/repurposed property degrades gracefully
// instead of erroring.
// ---------------------------------------------------------------------------

/** True when the upload-path properties exist on the Manifest. */
export async function manifestSupportsUploads(): Promise<boolean> {
  const schema = await manifestSchema();
  return schema.has(humanProps.sha256) && schema.has(humanProps.context);
}

// Notion caps a single rich_text item at 2000 chars; chunk long values.
function richTextChunks(text: string) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 2000) {
    chunks.push({ text: { content: text.slice(i, i + 2000) } });
  }
  return chunks;
}

function propertyPayload(type: string, value: string | string[]): any | null {
  const asString = Array.isArray(value) ? value.join(", ") : value;
  switch (type) {
    case "title":
      return { title: richTextChunks(asString || "Untitled") };
    case "rich_text":
      return { rich_text: asString ? richTextChunks(asString) : [] };
    case "url":
      return { url: asString || null };
    case "select":
      // Notion auto-creates select options on write.
      return { select: asString ? { name: asString.slice(0, 100) } : null };
    case "multi_select": {
      const names = Array.isArray(value) ? value : value ? [value] : [];
      return { multi_select: names.map((name) => ({ name: name.slice(0, 100) })) };
    }
    case "date":
      return { date: asString ? { start: asString } : null };
    case "number": {
      const n = Number(asString);
      return { number: Number.isFinite(n) ? n : null };
    }
    default:
      return null; // unknown type — skip rather than fail the write
  }
}

/**
 * Build a Notion properties object from name→value pairs, consulting the
 * live schema for each property's type. Properties missing from the schema
 * are skipped (run `npm run setup:upload` to add them).
 */
async function buildProperties(
  values: Record<string, string | string[] | undefined>,
): Promise<Record<string, any>> {
  const schema = await manifestSchema();
  const out: Record<string, any> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const type = schema.get(name);
    if (!type) continue;
    const payload = propertyPayload(type, value);
    if (payload) out[name] = payload;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading manifest entries
// ---------------------------------------------------------------------------

function readPeople(prop: any): PersonTag[] {
  const raw = plainText(prop);
  if (!raw.trim()) return [];
  try {
    return parsePeopleField(raw);
  } catch {
    // Hand-edited in Notion as plain names ("Kellie, Tom") — still usable.
    return raw
      .split(/[,;]+/)
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({ name }));
  }
}

function readTags(prop: any): string[] {
  if (prop?.type === "multi_select") {
    return (prop.multi_select ?? []).map((s: any) => s.name).filter(Boolean);
  }
  const raw = plainText(prop);
  return raw
    .split(/[,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function readDate(prop: any): string {
  if (prop?.type === "date") return prop.date?.start ?? "";
  return plainText(prop);
}

export function pageToManifestEntry(page: any): ManifestEntry {
  const p = page.properties ?? {};
  const title = plainText(p[props.title]) || "Untitled";
  const rightsKindRaw = plainText(p[humanProps.rights]).toLowerCase();
  const rightsKind = (RIGHTS_KINDS as readonly string[]).includes(rightsKindRaw)
    ? (rightsKindRaw as RightsKind)
    : "internal";
  return {
    id: page.id,
    title,
    url: plainText(p[props.imageUrl]),
    description: plainText(p[props.description]),
    driveLink: plainText(p[props.driveLink]),
    mediaType: detectMediaType(
      title,
      plainText(p[props.mimeType]),
      plainText(p[props.assetType]),
    ),
    context: plainText(p[humanProps.context]),
    people: readPeople(p[humanProps.people]),
    product: plainText(p[humanProps.product]),
    location: plainText(p[humanProps.location]),
    shoot: plainText(p[humanProps.shoot]),
    credit: plainText(p[humanProps.credit]),
    rights: { kind: rightsKind, notes: plainText(p[humanProps.rightsNotes]) },
    tags: readTags(p[humanProps.tags]),
    source: plainText(p[humanProps.source]),
    uploaded_by: plainText(p[humanProps.uploadedBy]),
    uploaded_at: readDate(p[humanProps.uploadedAt]) || page.created_time || "",
    sha256: plainText(p[humanProps.sha256]),
    phash: plainText(p[humanProps.phash]),
  };
}

/**
 * Retrieve an asset page, returning null when the id doesn't exist or isn't
 * a row of the Manifest (so /api/assets/:id can't read or write other
 * databases the integration can see, e.g. collections).
 */
export async function getAssetPage(id: string): Promise<any | null> {
  let page: any;
  try {
    page = await notionClient().pages.retrieve({ page_id: id });
  } catch {
    return null;
  }
  if (page.archived || page.in_trash) return null;
  const dataSourceId = await assetsDataSourceId();
  const parentId: string =
    page.parent?.data_source_id ?? page.parent?.database_id ?? "";
  const norm = (s: string) => s.replace(/-/g, "");
  if (norm(parentId) !== norm(dataSourceId)) return null;
  return page;
}

// ---------------------------------------------------------------------------
// Exact dedup — SHA-256 of the original bytes is the hard guarantee.
// ---------------------------------------------------------------------------

export async function findAssetBySha256(sha256: string): Promise<any | null> {
  const schema = await manifestSchema();
  if (!schema.has(humanProps.sha256)) return null; // pre-setup: no dedupe possible
  const res = (await notionClient().dataSources.query({
    data_source_id: await assetsDataSourceId(),
    filter: {
      property: humanProps.sha256,
      rich_text: { equals: sha256 },
    },
    page_size: 1,
  })) as any;
  const page = res.results?.find((r: any) => !r.archived && !r.in_trash);
  return page ?? null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function metadataPropertyValues(
  input: AssetMetadataInput,
): Record<string, string | string[] | undefined> {
  return {
    [humanProps.context]: input.context,
    [humanProps.people]:
      input.people === undefined ? undefined : JSON.stringify(input.people),
    [humanProps.product]: input.product,
    [humanProps.location]: input.location,
    [humanProps.shoot]: input.shoot,
    [humanProps.credit]: input.credit,
    [humanProps.rights]: input.rights?.kind,
    [humanProps.rightsNotes]: input.rights?.notes,
    [humanProps.tags]: input.tags,
    [humanProps.source]: input.source,
    [humanProps.uploadedBy]: input.uploaded_by,
  };
}

export interface CreateAssetInput {
  filename: string;
  url: string;
  mimeType: string;
  sha256: string;
  phash: string;
  metadata: AssetMetadataInput;
}

export async function createAssetEntry(
  input: CreateAssetInput,
): Promise<ManifestEntry> {
  const properties = await buildProperties({
    ...metadataPropertyValues(input.metadata),
    [props.title]: input.filename,
    [props.imageUrl]: input.url,
    [props.mimeType]: input.mimeType,
    [humanProps.sha256]: input.sha256,
    [humanProps.phash]: input.phash,
    [humanProps.uploadedAt]: new Date().toISOString(),
    // `internal` is the default rights kind (spec) — last so the spread's
    // possibly-undefined value can't clobber it.
    [humanProps.rights]: input.metadata.rights?.kind ?? "internal",
  });
  const page = (await notionClient().pages.create({
    parent: {
      type: "data_source_id",
      data_source_id: await assetsDataSourceId(),
    },
    properties,
  } as any)) as any;
  return pageToManifestEntry(page);
}

/** PATCH semantics: provided fields replace the stored values (backfill/edit). */
export async function updateAssetEntry(
  page: any,
  patch: AssetMetadataInput,
): Promise<ManifestEntry> {
  const properties = await buildProperties(metadataPropertyValues(patch));
  const updated = (await notionClient().pages.update({
    page_id: page.id,
    properties,
  } as any)) as any;
  return pageToManifestEntry(updated);
}

/**
 * Dedup-merge semantics (exact re-upload is a context contribution, not an
 * error): freeform context is appended, people/tags are unioned, scalar
 * fields fill only when currently empty. Nothing human-authored is lost.
 */
export async function mergeContribution(
  page: any,
  incoming: AssetMetadataInput,
): Promise<ManifestEntry> {
  const existing = pageToManifestEntry(page);
  const patch: AssetMetadataInput = {};

  const newContext = incoming.context?.trim();
  if (newContext && !existing.context.includes(newContext)) {
    patch.context = existing.context
      ? `${existing.context}\n${newContext}`
      : newContext;
  }

  if (incoming.people?.length) {
    const byName = new Map(
      existing.people.map((p) => [p.name.toLowerCase(), { ...p }]),
    );
    let changed = false;
    for (const person of incoming.people) {
      const key = person.name.toLowerCase();
      const current = byName.get(key);
      if (!current) {
        byName.set(key, person);
        changed = true;
      } else if (person.consent !== undefined && current.consent === undefined) {
        current.consent = person.consent;
        changed = true;
      }
    }
    if (changed) patch.people = [...byName.values()];
  }

  if (incoming.tags?.length) {
    const have = new Set(existing.tags.map((t) => t.toLowerCase()));
    const added = incoming.tags.filter((t) => !have.has(t.toLowerCase()));
    if (added.length) patch.tags = [...existing.tags, ...added];
  }

  const fillIfEmpty = (
    field: "product" | "location" | "shoot" | "credit" | "source" | "uploaded_by",
  ) => {
    const value = incoming[field]?.trim();
    if (value && !existing[field]) patch[field] = value;
  };
  fillIfEmpty("product");
  fillIfEmpty("location");
  fillIfEmpty("shoot");
  fillIfEmpty("credit");
  fillIfEmpty("source");
  fillIfEmpty("uploaded_by");

  if (incoming.rights?.notes && !existing.rights.notes) {
    patch.rights = { ...patch.rights, notes: incoming.rights.notes };
  }

  if (Object.keys(patch).length === 0) return existing;
  return updateAssetEntry(page, patch);
}

// ---------------------------------------------------------------------------
// AI channel — write a Gemini manifest onto an existing row. The two-channel
// rule still holds: this only ever touches enrichment properties, never the
// human ones. Properties absent from the live schema are skipped.
// ---------------------------------------------------------------------------

/** Render the video beat breakdown into the single rich_text Notion property. */
function formatBeats(manifest: AssetManifest): string | undefined {
  if (!manifest.beats?.length) return undefined;
  return manifest.beats
    .map(
      (b) =>
        `${b.start_s}–${b.end_s}s: ${b.shot_description} [${b.shot_type}; use: ${b.ai_usefulness}]`,
    )
    .join("\n");
}

function manifestPropertyValues(
  manifest: AssetManifest,
): Record<string, string | string[] | undefined> {
  const values: Record<string, string | string[] | undefined> = {
    [aiProps.description]: manifest.overall_description || undefined,
    [aiProps.contentType]: manifest.content_type || undefined,
    [aiProps.moodTone]: manifest.mood_tone.length ? manifest.mood_tone : undefined,
    [aiProps.visualTags]: manifest.visual_tags.length
      ? manifest.visual_tags
      : undefined,
    [aiProps.peoplePresent]: manifest.people_present || undefined,
    [aiProps.productsFlowers]: manifest.products_or_flowers.length
      ? manifest.products_or_flowers
      : undefined,
    [aiProps.settingLocation]: manifest.setting_location || undefined,
    [aiProps.usableFor]: manifest.usable_for.length
      ? manifest.usable_for
      : undefined,
    [aiProps.reorgNotes]: manifest.reorg_notes || undefined,
    [aiProps.timestampBeats]: formatBeats(manifest),
  };

  const pc = manifest.product_classification;
  if (pc) {
    values[aiProps.containsProduct] = pc.contains_product ? "yes" : "no";
    if (pc.product_name) values[aiProps.productName] = pc.product_name;
    values[aiProps.productConfidence] = String(Math.round(pc.confidence * 100));
  }
  return values;
}

/**
 * Write a Gemini manifest onto the row and return the refreshed entry (its
 * `description` now carries the AI overview, so re-embedding picks it up).
 */
export async function writeManifest(
  pageId: string,
  manifest: AssetManifest,
): Promise<ManifestEntry> {
  const properties = await buildProperties(manifestPropertyValues(manifest));
  const updated = (await notionClient().pages.update({
    page_id: pageId,
    properties,
  } as any)) as any;
  return pageToManifestEntry(updated);
}

// ---------------------------------------------------------------------------
// Recent uploads — powers the post-upload review/edit page. Newest first.
// ---------------------------------------------------------------------------

export async function listRecentManifestEntries(
  limit = 30,
): Promise<ManifestEntry[]> {
  const res = (await notionClient().dataSources.query({
    data_source_id: await assetsDataSourceId(),
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: Math.min(Math.max(limit, 1), 100),
  })) as any;
  return res.results
    .filter((p: any) => !p.archived && !p.in_trash)
    .map(pageToManifestEntry);
}

// ---------------------------------------------------------------------------
// Upload validation constants
// ---------------------------------------------------------------------------

/** Accepted upload types → canonical extension. HEIC is transcoded to JPEG. */
export const ACCEPTED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heic",
};

const EXT_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

/** Resolve the upload's MIME type from the Blob type or filename extension. */
export function resolveUploadMime(
  declaredType: string,
  filename: string,
): string | null {
  const declared = declaredType.toLowerCase().split(";")[0].trim();
  if (ACCEPTED_TYPES[declared]) return declared;
  const m = /\.([a-z0-9]+)$/i.exec(filename.trim());
  const byExt = m ? EXT_TO_MIME[m[1].toLowerCase()] : undefined;
  return byExt && ACCEPTED_TYPES[byExt] ? byExt : null;
}

export const MAX_UPLOAD_BYTES = uploadConfig.maxBytes;
