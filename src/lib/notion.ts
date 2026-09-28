import "server-only";

import { Client } from "@notionhq/client";

import {
  COLLECTION_ASSETS_PROP,
  COLLECTION_CRITERIA_PROP,
  COLLECTION_NAME_PROP,
  COLLECTION_SUMMARY_PROP,
  COLLECTION_TYPE_PROP,
  humanKeywordProps,
  humanProps,
  notionConfig,
  props,
  keywordTextProps,
} from "./config";
import {
  compileCriteria,
  describeCriteria,
  parseCriteria,
  toRichTextSegments,
  validateCriteria,
  type CollectionCriteria,
  type CriteriaProblem,
} from "./collectionCriteria";
import { detectMediaType } from "./media";
import type {
  Asset,
  Collection,
  CollectionKind,
  CollectionSummary,
  SearchResponse,
} from "./types";

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

let client: Client | null = null;

function notion(): Client {
  if (!notionConfig.token) {
    throw new Error(
      "NOTION_TOKEN is not set. Copy .env.local.example to .env.local and fill it in.",
    );
  }
  if (!client) {
    // Raise the per-request timeout above the 60s default: retrieving the
    // Manifest data source's schema (with its accumulated multi_select option
    // lists) can be slow, and the upload path can't proceed without it.
    client = new Client({
      auth: notionConfig.token,
      timeoutMs: Number(process.env.NOTION_TIMEOUT_MS ?? 120000),
    });
  }
  return client;
}

// --- retry --------------------------------------------------------------------
// The runtime equivalent of the build script's resilience (PR #2): the Notion
// SDK does not retry request timeouts or 5xx on its own, so a single slow call
// fails the whole request. Wrap the hot-path calls so a transient hiccup is
// absorbed instead of surfacing as a failed upload.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetriableNotionError(err: unknown): boolean {
  const e = err as { code?: string; status?: number } | undefined;
  const status = e?.status;
  return (
    e?.code === "notionhq_client_request_timeout" ||
    e?.code === "notionhq_client_response_error" ||
    e?.code === "ECONNRESET" ||
    e?.code === "ETIMEDOUT" ||
    e?.code === "ENOTFOUND" ||
    status === 429 ||
    (typeof status === "number" && status >= 500)
  );
}

export async function notionRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxRetries = Number(process.env.NOTION_MAX_RETRIES ?? 3),
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetriableNotionError(err) || attempt === maxRetries) break;
      const base = Math.min(1000 * 2 ** attempt, 8000);
      const delay = Math.round(base * (0.8 + Math.random() * 0.4));
      const reason =
        (err as { code?: string; status?: number })?.code ??
        (err as { status?: number })?.status;
      console.warn(
        `notion ${label} failed (${reason}); retry ${attempt + 1}/${maxRetries} in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Data source resolution (cached per process)
// ---------------------------------------------------------------------------

let cachedAssetsDataSourceId: string | null =
  notionConfig.assetsDataSourceId || null;
let cachedCollectionsDataSourceId: string | null =
  notionConfig.collectionsDataSourceId || null;

async function firstDataSourceId(databaseId: string): Promise<string> {
  // The 2025-09-03 API exposes a database's data sources on retrieve().
  const db = (await notion().databases.retrieve({
    database_id: databaseId,
  })) as unknown as { data_sources?: Array<{ id: string }> };
  const id = db.data_sources?.[0]?.id;
  if (!id) {
    throw new Error(`No data source found for database ${databaseId}`);
  }
  return id;
}

async function assetsDataSourceId(): Promise<string> {
  if (!cachedAssetsDataSourceId) {
    cachedAssetsDataSourceId = await firstDataSourceId(
      notionConfig.assetsDatabaseId,
    );
  }
  return cachedAssetsDataSourceId;
}

// Shared with the asset upload path (src/lib/assets.ts).
export { notion as notionClient, assetsDataSourceId };

// ---------------------------------------------------------------------------
// Manifest schema (property name → type), cached per process. Lets writes and
// keyword filters adapt to what actually exists — the upload-path properties
// only appear after `npm run setup:upload`.
// ---------------------------------------------------------------------------

let cachedManifestSchema: Map<string, string> | null = null;
let manifestSchemaInFlight: Promise<Map<string, string>> | null = null;

export async function manifestSchema(): Promise<Map<string, string>> {
  if (cachedManifestSchema) return cachedManifestSchema;
  // De-dupe concurrent callers (every upload checks the schema) onto a single
  // retrieve, and retry transient timeouts. On failure, clear the in-flight
  // promise so the next caller retries rather than inheriting the rejection.
  if (!manifestSchemaInFlight) {
    manifestSchemaInFlight = (async () => {
      const dataSourceId = await assetsDataSourceId();
      const ds = (await notionRetry("manifest schema retrieve", () =>
        notion().dataSources.retrieve({ data_source_id: dataSourceId }),
      )) as unknown as { properties?: Record<string, { type: string }> };
      const map = new Map<string, string>();
      for (const [name, def] of Object.entries(ds.properties ?? {})) {
        map.set(name, def.type);
      }
      cachedManifestSchema = map;
      return map;
    })().catch((err) => {
      manifestSchemaInFlight = null;
      throw err;
    });
  }
  return manifestSchemaInFlight;
}

// Pre-warm the schema cache on first server import so the (potentially slow)
// retrieve happens in the background — off the user's upload click path. The
// first page/search request that imports this module triggers it; by the time
// an upload runs, the schema is usually already cached.
if (
  notionConfig.token &&
  process.env.NEXT_PHASE !== "phase-production-build"
) {
  void manifestSchema().catch(() => {
    /* best-effort warm; real callers will retry */
  });
}

/**
 * The option vocabulary for the rule builder, read from the Manifest data
 * source's schema. Notion already stores every multi_select/select option
 * there, so this needs no extra scan of the assets — at the cost of possibly
 * offering an option that no asset currently uses, which is why the builder
 * also shows a live match count per rule.
 */
export interface ManifestVocabulary {
  tags: string[];
  source: string[];
  rights: string[];
}

let cachedVocabulary: { at: number; value: ManifestVocabulary } | null = null;

/**
 * How long the option vocabulary is reused. Short enough that a tag added in
 * Notion shows up in the builder soon; `validateCriteriaAgainstSchema` also
 * forces a refresh before rejecting a value, so validation never lags.
 */
const VOCABULARY_CACHE_MS = 5 * 60_000;

export async function manifestVocabulary(
  { fresh = false }: { fresh?: boolean } = {},
): Promise<ManifestVocabulary> {
  if (
    !fresh &&
    cachedVocabulary &&
    Date.now() - cachedVocabulary.at < VOCABULARY_CACHE_MS
  ) {
    return cachedVocabulary.value;
  }

  const dataSourceId = await assetsDataSourceId();
  const ds = (await notionRetry("manifest vocabulary retrieve", () =>
    notion().dataSources.retrieve({ data_source_id: dataSourceId }),
  )) as unknown as {
    properties?: Record<string, { type: string; [k: string]: unknown }>;
  };

  const optionsFor = (name: string, type: "multi_select" | "select"): string[] => {
    const def = ds.properties?.[name];
    if (!def || def.type !== type) return [];
    const list = (def[type] as { options?: Array<{ name?: string }> } | undefined)
      ?.options;
    return (list ?? [])
      .map((o) => o?.name)
      .filter((n): n is string => Boolean(n));
  };

  const value: ManifestVocabulary = {
    // Sorted so the picker is browsable rather than schema-insertion order.
    tags: optionsFor(humanProps.tags, "multi_select").sort((a, b) =>
      a.localeCompare(b),
    ),
    source: optionsFor(humanProps.source, "select"),
    rights: optionsFor(humanProps.rights, "select"),
  };
  cachedVocabulary = { at: Date.now(), value };
  return value;
}

/**
 * Validate a rule against the live Manifest schema, so a select/multi_select
 * value that is not a real option is rejected before it is saved. (Notion
 * itself refuses a filter on an unknown option, which would otherwise leave
 * the collection permanently empty.) A cached vocabulary that rejects a value
 * is refreshed once first, so a tag added in Notion moments ago still passes.
 */
export async function validateCriteriaAgainstSchema(
  criteria: CollectionCriteria,
): Promise<CriteriaProblem[]> {
  const known = (v: ManifestVocabulary) => ({
    tags: v.tags,
    source: v.source,
    rights: v.rights,
  });
  const problems = validateCriteria(criteria, known(await manifestVocabulary()));
  if (!problems.some((p) => p.message.includes("is not an existing"))) {
    return problems;
  }
  return validateCriteria(criteria, known(await manifestVocabulary({ fresh: true })));
}

async function collectionsDataSourceId(): Promise<string> {
  if (!cachedCollectionsDataSourceId) {
    if (!notionConfig.collectionsDatabaseId) {
      throw new Error(
        "Collections database is not configured. Run `npm run setup:collections` and set NOTION_COLLECTIONS_DATABASE_ID.",
      );
    }
    cachedCollectionsDataSourceId = await firstDataSourceId(
      notionConfig.collectionsDatabaseId,
    );
  }
  return cachedCollectionsDataSourceId;
}

// ---------------------------------------------------------------------------
// Property extraction helpers
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

export function plainText(prop: any): string {
  if (!prop) return "";
  if (prop.type === "title") return joinRichText(prop.title);
  if (prop.type === "rich_text") return joinRichText(prop.rich_text);
  if (prop.type === "url") return prop.url ?? "";
  if (prop.type === "select") return prop.select?.name ?? "";
  return "";
}

function joinRichText(arr: any[]): string {
  if (!Array.isArray(arr)) return "";
  return arr.map((t) => t.plain_text ?? "").join("");
}

function pageToAsset(page: any): Asset {
  const p = page.properties ?? {};
  const title = plainText(p[props.title]) || "Untitled";
  return {
    id: page.id,
    title,
    url: plainText(p[props.imageUrl]),
    description: plainText(p[props.description]),
    driveLink: plainText(p[props.driveLink]),
    dimensions: plainText(p[props.dimensions]),
    // Only app uploads carry `Uploaded At`, and only app uploads store the
    // untouched original at `url` — see Asset.cdnIsOriginal.
    cdnIsOriginal: Boolean(p[humanProps.uploadedAt]?.date?.start),
    mediaType: detectMediaType(
      title,
      plainText(p[props.mimeType]),
      plainText(p[props.assetType]),
    ),
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function buildFilter(query: string): Promise<any | undefined> {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return undefined;

  // Only filter on rich_text properties that actually exist — the human
  // upload-path props are absent until `npm run setup:upload` has run, and
  // Notion rejects filters on unknown properties.
  let textProps = keywordTextProps;
  try {
    const schema = await manifestSchema();
    textProps = [...keywordTextProps, ...humanKeywordProps].filter(
      (name) => schema.get(name) === "rich_text",
    );
  } catch {
    // Schema lookup failed — fall back to the long-standing AI-channel props.
  }

  const conditions = terms.map((term) => ({
    or: [
      { property: props.title, title: { contains: term } },
      ...textProps.map((name) => ({
        property: name,
        rich_text: { contains: term },
      })),
    ],
  }));

  if (conditions.length === 1) return conditions[0];
  return { and: conditions };
}

export async function searchAssets(
  query: string,
  cursor?: string,
  pageSize = 24,
): Promise<SearchResponse> {
  const response = (await notion().dataSources.query({
    data_source_id: await assetsDataSourceId(),
    filter: await buildFilter(query),
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: pageSize,
    ...(cursor ? { start_cursor: cursor } : {}),
  })) as any;

  const results: Asset[] = response.results
    .filter((page: any) => !page.archived && !page.in_trash)
    .map(pageToAsset);

  return {
    results,
    nextCursor: response.has_more ? response.next_cursor : null,
  };
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

/**
 * How many assets one smart collection will resolve per view. A broad rule
 * ("Match any" on a common tag) would otherwise page through the whole
 * Manifest on every render; past this the result is marked truncated.
 */
const SMART_COLLECTION_MAX = Number(
  process.env.SMART_COLLECTION_MAX ?? "500",
);

/**
 * How long a resolved smart collection is reused. Live means "current", not
 * "re-queried on every render" — a short window keeps repeat views cheap while
 * still picking up new assets quickly.
 */
const SMART_COLLECTION_CACHE_MS = Number(
  process.env.SMART_COLLECTION_CACHE_MS ?? "60000",
);

interface SmartCacheEntry {
  at: number;
  /** Serialised criteria this entry was computed for, so an edit invalidates. */
  key: string;
  items: Asset[];
  truncated: boolean;
}

const smartCache = new Map<string, SmartCacheEntry>();

/** Drop a cached evaluation — called when a smart collection is edited. */
export function invalidateSmartCollection(id: string): void {
  smartCache.delete(id);
}

function collectionKind(page: any): CollectionKind {
  return plainText(page.properties?.[COLLECTION_TYPE_PROP]) === "smart"
    ? "smart"
    : "manual";
}

function collectionCriteria(page: any): CollectionCriteria | null {
  return parseCriteria(plainText(page.properties?.[COLLECTION_CRITERIA_PROP]));
}

/**
 * Evaluate a smart rule by querying the Manifest through the compiled Notion
 * filter, paging until the cap is reached. Results are cached briefly so a
 * render pass does not re-query.
 */
async function queryByCriteria(
  criteria: CollectionCriteria,
): Promise<{ items: Asset[]; truncated: boolean }> {
  // Throws with a readable message on an invalid rule, rather than silently
  // resolving to "no filter" (which would mean the entire Manifest).
  const filter = compileCriteria(criteria);
  const dataSourceId = await assetsDataSourceId();

  const items: Asset[] = [];
  let cursor: string | undefined;
  let truncated = false;

  do {
    const response = (await notionRetry("smart collection query", () =>
      notion().dataSources.query({
        data_source_id: dataSourceId,
        // Our compiler emits plain Notion filter JSON; the SDK models it as a
        // closed union, so the object is asserted at this boundary.
        filter: filter as any,
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: Math.min(100, SMART_COLLECTION_MAX - items.length),
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    )) as any;

    for (const page of response.results ?? []) {
      if (page.archived || page.in_trash) continue;
      items.push(pageToAsset(page));
      if (items.length >= SMART_COLLECTION_MAX) break;
    }

    if (items.length >= SMART_COLLECTION_MAX) {
      // Cap reached. `has_more` is not consulted past this point on purpose:
      // we have everything we are willing to render.
      truncated = Boolean(response.has_more) || items.length > SMART_COLLECTION_MAX;
      cursor = undefined;
    } else {
      cursor = response.has_more ? response.next_cursor : undefined;
    }
  } while (cursor);

  return { items: items.slice(0, SMART_COLLECTION_MAX), truncated };
}

/**
 * Cached evaluation for a stored smart collection. The cache is keyed by both
 * the collection id and the serialised rule, so editing a rule invalidates it
 * even before the explicit invalidate call.
 */
async function resolveSmartCollection(
  id: string,
  criteria: CollectionCriteria,
): Promise<{ items: Asset[]; truncated: boolean }> {
  const key = JSON.stringify(criteria);
  const hit = smartCache.get(id);
  if (hit && hit.key === key && Date.now() - hit.at < SMART_COLLECTION_CACHE_MS) {
    return { items: hit.items, truncated: hit.truncated };
  }
  const { items, truncated } = await queryByCriteria(criteria);
  smartCache.set(id, { at: Date.now(), key, items, truncated });
  return { items, truncated };
}

/**
 * Count the assets a rule matches, for the builder's live preview. Bounded by
 * the same cap as evaluation, so a `truncated` result means "at least this
 * many" rather than an exact total.
 */
export async function countCriteriaMatches(
  criteria: CollectionCriteria,
): Promise<{ count: number; truncated: boolean }> {
  const { items, truncated } = await queryByCriteria(criteria);
  return { count: items.length, truncated };
}

export async function createCollection(
  name: string,
  assetIds: string[],
  criteria?: CollectionCriteria | null,
): Promise<{ id: string }> {
  const dataSourceId = await collectionsDataSourceId();
  const isSmart = Boolean(criteria);

  const properties: Record<string, unknown> = {
    [COLLECTION_NAME_PROP]: {
      title: [{ text: { content: name || "Untitled collection" } }],
    },
    [COLLECTION_ASSETS_PROP]: {
      // A smart collection derives its members; the relation stays empty.
      relation: isSmart ? [] : assetIds.map((id) => ({ id })),
    },
  };

  if (isSmart) {
    properties[COLLECTION_TYPE_PROP] = { select: { name: "smart" } };
    properties[COLLECTION_CRITERIA_PROP] = {
      rich_text: toRichTextSegments(JSON.stringify(criteria)),
    };
    properties[COLLECTION_SUMMARY_PROP] = {
      rich_text: toRichTextSegments(describeCriteria(criteria as CollectionCriteria)),
    };
  }

  const page = (await notion().pages.create({
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    properties,
  } as any)) as any;

  return { id: page.id };
}

/** Thrown when a rule is sent to a collection that is not a smart one. */
export class NotSmartCollectionError extends Error {
  constructor() {
    super(
      "This is a hand-picked collection. Rules can only be edited on smart " +
        "collections; create a new smart collection instead.",
    );
    this.name = "NotSmartCollectionError";
  }
}

/**
 * Replace a smart collection's rule. Also rewrites the human-readable summary
 * so the Notion view stays legible, and drops the cached evaluation.
 *
 * Refuses a manual collection: converting one would silently orphan its
 * hand-picked `Assets` relation.
 */
export async function updateCollectionCriteria(
  id: string,
  criteria: CollectionCriteria,
  name?: string,
): Promise<void> {
  const page = (await notionRetry("collection retrieve", () =>
    notion().pages.retrieve({ page_id: id }),
  )) as any;
  if (collectionKind(page) !== "smart") throw new NotSmartCollectionError();

  const properties: Record<string, unknown> = {
    [COLLECTION_CRITERIA_PROP]: {
      rich_text: toRichTextSegments(JSON.stringify(criteria)),
    },
    [COLLECTION_SUMMARY_PROP]: {
      rich_text: toRichTextSegments(describeCriteria(criteria)),
    },
  };
  if (name) {
    properties[COLLECTION_NAME_PROP] = { title: [{ text: { content: name } }] };
  }

  await notion().pages.update({ page_id: id, properties } as any);
  invalidateSmartCollection(id);
}

/**
 * List saved collections, newest first. Returns lightweight summaries (name +
 * asset count) without fetching the linked asset rows, so it stays cheap even
 * with many collections. `assetCount` reflects the relations returned on the
 * first page (Notion caps relation arrays at 25); `partialCount` flags when
 * there are more.
 */
export async function listCollections(
  limit = 100,
): Promise<CollectionSummary[]> {
  const response = (await notion().dataSources.query({
    data_source_id: await collectionsDataSourceId(),
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: Math.min(limit, 100),
  })) as any;

  return response.results
    .filter((page: any) => !page.archived && !page.in_trash)
    .map((page: any): CollectionSummary => {
      const rel = page.properties?.[COLLECTION_ASSETS_PROP];
      const relations = rel?.type === "relation" ? rel.relation : [];
      return {
        id: page.id,
        name: plainText(page.properties?.[COLLECTION_NAME_PROP]) || "Collection",
        kind: collectionKind(page),
        // For a smart collection this relation is intentionally empty; the
        // real count is only known by evaluating the rule, which the list view
        // deliberately does not do (it would mean a query per row).
        assetCount: relations.length,
        partialCount: Boolean(rel?.has_more),
        createdTime: page.created_time ?? "",
      };
    });
}

/** Rename a collection (updates its Name title property). */
export async function renameCollection(
  id: string,
  name: string,
): Promise<void> {
  await notion().pages.update({
    page_id: id,
    properties: {
      [COLLECTION_NAME_PROP]: {
        title: [{ text: { content: name } }],
      },
    },
  } as any);
}

/**
 * Delete a collection. The Notion API has no hard delete, so we archive the
 * page; listCollections and getCollection already ignore archived/trashed
 * pages, so it disappears from the app immediately.
 */
export async function deleteCollection(id: string): Promise<void> {
  await notion().pages.update({ page_id: id, archived: true } as any);
}

/** Read every related asset id, following pagination if there are > 25. */
async function relationIds(page: any): Promise<string[]> {
  const prop = page.properties?.[COLLECTION_ASSETS_PROP];
  if (!prop || prop.type !== "relation") return [];

  const ids: string[] = prop.relation.map((r: any) => r.id);
  if (!prop.has_more) return ids;

  // Page through the rest via the property items endpoint.
  let cursor: string | undefined;
  do {
    const res = (await notion().pages.properties.retrieve({
      page_id: page.id,
      property_id: prop.id,
      ...(cursor ? { start_cursor: cursor } : {}),
    } as any)) as any;
    for (const item of res.results ?? []) {
      if (item.type === "relation" && item.relation?.id) {
        ids.push(item.relation.id);
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return ids;
}

/**
 * True when `id` looks like a Notion page id (UUID, dashed or not). Dynamic
 * routes like /api/collections/[id] happily match path segments such as
 * "search", and passing those through to pages.retrieve makes the Notion
 * client log a validation error on every hit — reject them up front.
 */
export function isNotionPageId(id: string): boolean {
  return /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(
    id,
  );
}

export async function getCollection(id: string): Promise<Collection | null> {
  if (!isNotionPageId(id)) return null;
  let page: any;
  try {
    page = await notion().pages.retrieve({ page_id: id });
  } catch {
    return null;
  }

  const name =
    plainText(page.properties?.[COLLECTION_NAME_PROP]) || "Collection";
  const kind = collectionKind(page);
  const criteria = collectionCriteria(page);

  // A smart collection re-evaluates its rule against the current Manifest, so
  // its membership tracks new and edited assets without anyone re-saving it.
  if (kind === "smart" && criteria) {
    // The summary is rendered from the same helper that fills the Rule Summary
    // property, so the UI and Notion never disagree about the wording.
    const summary = describeCriteria(criteria);
    try {
      const { items, truncated } = await resolveSmartCollection(id, criteria);
      return { id, name, items, kind, criteria, summary, truncated, evaluationError: null };
    } catch (err) {
      // A rule we can no longer compile (e.g. a property was renamed in Notion)
      // should degrade to an empty view with the reason logged, not take down
      // the whole collections page.
      console.error(`smart collection ${id} failed to evaluate`, err);
      // Carry the reason to the UI too, so an empty view is explained (e.g. a
      // tag that was renamed or deleted in Notion) instead of looking empty.
      // Notion appends every option name to an unknown-option error; keep
      // just the part that says what is wrong.
      const evaluationError =
        err instanceof Error
          ? err.message.split(". Available options:")[0]
          : "This rule could not be evaluated.";
      return { id, name, items: [], kind, criteria, summary, truncated: false, evaluationError };
    }
  }

  const ids = await relationIds(page);

  // Fetch the related asset rows in parallel. Missing/deleted assets are
  // silently dropped.
  const settled = await Promise.allSettled(
    ids.map((assetId) => notion().pages.retrieve({ page_id: assetId })),
  );
  const items: Asset[] = settled
    .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
    .map((r) => pageToAsset(r.value));

  return { id, name, items, kind, criteria, summary: "", truncated: false, evaluationError: null };
}
