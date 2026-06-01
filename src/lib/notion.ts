import "server-only";

import { Client } from "@notionhq/client";

import {
  COLLECTION_ASSETS_PROP,
  COLLECTION_NAME_PROP,
  notionConfig,
  props,
  keywordTextProps,
} from "./config";
import { detectMediaType } from "./media";
import type { Asset, Collection, SearchResponse } from "./types";

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
    client = new Client({ auth: notionConfig.token });
  }
  return client;
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

function plainText(prop: any): string {
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

function buildFilter(query: string): any | undefined {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return undefined;

  const conditions = terms.map((term) => ({
    or: [
      { property: props.title, title: { contains: term } },
      ...keywordTextProps.map((name) => ({
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
    filter: buildFilter(query),
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: pageSize,
    ...(cursor ? { start_cursor: cursor } : {}),
  })) as any;

  const results: Asset[] = response.results.map(pageToAsset);

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
