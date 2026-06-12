import "server-only";

import { Client } from "@notionhq/client";

import {
  COLLECTION_ASSETS_PROP,
  COLLECTION_NAME_PROP,
  humanKeywordProps,
  notionConfig,
  props,
  keywordTextProps,
} from "./config";
import { detectMediaType } from "./media";
import type {
  Asset,
  Collection,
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

export async function createCollection(
  name: string,
  assetIds: string[],
): Promise<{ id: string }> {
  const dataSourceId = await collectionsDataSourceId();
  const page = (await notion().pages.create({
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    properties: {
      [COLLECTION_NAME_PROP]: {
        title: [{ text: { content: name || "Untitled collection" } }],
      },
      [COLLECTION_ASSETS_PROP]: {
        relation: assetIds.map((id) => ({ id })),
      },
    },
  } as any)) as any;

  return { id: page.id };
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

export async function getCollection(id: string): Promise<Collection | null> {
  let page: any;
  try {
    page = await notion().pages.retrieve({ page_id: id });
  } catch {
    return null;
  }

  const name =
    plainText(page.properties?.[COLLECTION_NAME_PROP]) || "Collection";
  const ids = await relationIds(page);

  // Fetch the related asset rows in parallel. Missing/deleted assets are
  // silently dropped.
  const settled = await Promise.allSettled(
    ids.map((assetId) => notion().pages.retrieve({ page_id: assetId })),
  );
  const items: Asset[] = settled
    .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
    .map((r) => pageToAsset(r.value));

  return { id, name, items };
}
