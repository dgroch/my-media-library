import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Machine-readable description of the public API, so agents (Claude tool use,
// MCP gateways, etc.) can discover and call the endpoints without hand-written
// schemas. Served at /openapi.json. The `servers` entry is derived from the
// incoming request so the spec is correct on any host/deployment.
export async function GET(request: Request) {
  const origin = new URL(request.url).origin;

  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Asset Library API",
      version: "1.0.0",
      description:
        "Semantic search over the Brand Asset Manifest, shareable asset collections, " +
        "and the asset upload path. Reads are public. Creating a collection may " +
        "require a bearer token if the deployment sets API_WRITE_TOKEN; uploading " +
        "or editing assets always requires the ASSET_LIBRARY_TOKEN bearer token.",
    },
    servers: [{ url: origin }],
    paths: {
      "/api/assets": {
        post: {
          operationId: "uploadAsset",
          summary: "Upload an image to the asset library",
          description:
            "Adds an image (jpeg/png/webp/heic; heic is transcoded to jpeg; max 25 MB) " +
            "and returns a permanent CDN URL that is searchable within seconds. " +
            "Byte-identical re-uploads never create a second asset: they return 200 " +
            "with `deduped: true` and the submitted context merged into the existing " +
            "entry. Near-duplicates (resizes, re-exports, light crops) are listed " +
            "under `similar`; send `on_similar=reject` to get a 409 instead of " +
            "creating the asset. Include human context at upload — people, product, " +
            "place are things the AI classifier can't know, and they win in search.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["file"],
                  properties: {
                    file: {
                      type: "string",
                      format: "binary",
                      description: "jpeg / png / webp / heic, max 25 MB.",
                    },
                    context: {
                      type: "string",
                      description:
                        "Freeform human description, stored verbatim, e.g. " +
                        "\"Kellie tying the morning's stems, Melbourne studio\".",
                    },
                    people: {
                      type: "string",
                      description:
                        'JSON array with per-person consent, e.g. [{"name":"Kellie","consent":true}].',
                    },
                    product: {
                      type: "string",
                      description: 'Named design if applicable ("Osaka", "Lucerne").',
                    },
                    location: { type: "string" },
                    shoot: {
                      type: "string",
                      description: 'Batch/shoot label ("June 2026 studio shoot").',
                    },
                    credit: {
                      type: "string",
                      description: "Photographer / source attribution.",
                    },
                    rights: {
                      type: "string",
                      enum: ["internal", "licensed", "restricted"],
                      default: "internal",
                    },
                    tags: {
                      type: "string",
                      description: 'JSON array of strings, e.g. ["studio","bts"].',
                    },
                    source: {
                      type: "string",
                      description:
                        "Origin app id (social-builder, brand-photographer, drive-sync).",
                    },
                    uploaded_by: {
                      type: "string",
                      description: "Person or agent identifier.",
                    },
                    on_similar: {
                      type: "string",
                      enum: ["accept", "reject"],
                      default: "accept",
                      description:
                        "reject → 409 when a near-duplicate exists (for agents that " +
                        "should defer to existing assets).",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description:
                "Asset created. `similar` lists near-duplicates (advisory).",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/UploadedAsset" },
                },
              },
            },
            "200": {
              description:
                "Exact duplicate: no new asset. The existing entry is returned with " +
                "the submitted context merged in.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["deduped", "asset"],
                    properties: {
                      deduped: { type: "boolean", const: true },
                      asset: { $ref: "#/components/schemas/ManifestEntry" },
                    },
                  },
                },
              },
            },
            "409": {
              description:
                "Near-duplicate found and the caller sent on_similar=reject.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["similar"],
                    properties: {
                      similar: {
                        type: "array",
                        items: { $ref: "#/components/schemas/SimilarAsset" },
                      },
                    },
                  },
                },
              },
            },
            "413": {
              description: "File too large (max 25 MB).",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "415": {
              description: "Unsupported file type.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "401": {
              description: "Bearer token missing.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "403": {
              description: "Bearer token invalid.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
      "/api/derived/{namespace}/{name}": {
        put: {
          operationId: "putDerivedObject",
          summary: "Store a derived object (render cache tier)",
          description:
            "Content-addressed CDN storage for objects derived from brand assets " +
            "— e.g. the social builder's render cache " +
            "(PUT /api/derived/render/{hash}.png with the raw bytes as the body). " +
            "Idempotent: re-PUTting an existing key is a no-op 200. Derived " +
            "objects are NOT brand assets: no manifest row, no dedup, no AI " +
            "enrichment, and they never appear in /api/search. Eviction is left " +
            "to a bucket lifecycle rule — a cold miss just re-renders.",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "namespace",
              in: "path",
              required: true,
              description: "Object namespace, e.g. `render`.",
              schema: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$" },
            },
            {
              name: "name",
              in: "path",
              required: true,
              description:
                "Content-addressed filename with extension, e.g. `<sha256>.png`.",
              schema: {
                type: "string",
                pattern: "^[a-z0-9][a-z0-9_-]*\\.[a-z0-9]{2,5}$",
              },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/octet-stream": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          responses: {
            "201": {
              description: "Object stored.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/DerivedObject" },
                },
              },
            },
            "200": {
              description: "Already existed — no-op.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/DerivedObject" },
                },
              },
            },
            "400": {
              description: "Invalid path or empty body.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "401": {
              description: "Bearer token missing.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "403": {
              description: "Bearer token invalid.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "413": {
              description: "Object too large.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
      "/api/assets/{id}": {
        get: {
          operationId: "getAsset",
          summary: "Get a full manifest entry",
          description:
            "Returns the asset's full manifest entry, including the human-context " +
            "fields and search-indexing status.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "The manifest entry.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ManifestEntry" },
                },
              },
            },
            "404": {
              description: "No such asset.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
        patch: {
          operationId: "updateAssetMetadata",
          summary: "Add or correct human context on an asset",
          description:
            "The backfill path: add \"that's Kellie\" to a years-old photo and it " +
            "becomes findable. Provided fields replace stored values; omitted fields " +
            "are untouched. The asset is re-embedded on change. Human fields are " +
            "never overwritten by AI enrichment.",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    context: { type: "string" },
                    people: {
                      type: "array",
                      items: { $ref: "#/components/schemas/PersonTag" },
                    },
                    product: { type: "string" },
                    location: { type: "string" },
                    shoot: { type: "string" },
                    credit: { type: "string" },
                    rights: {
                      oneOf: [
                        {
                          type: "string",
                          enum: ["internal", "licensed", "restricted"],
                        },
                        { $ref: "#/components/schemas/Rights" },
                      ],
                    },
                    tags: { type: "array", items: { type: "string" } },
                    source: { type: "string" },
                    uploaded_by: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "The updated manifest entry.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ManifestEntry" },
                },
              },
            },
            "400": {
              description: "Invalid body.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "401": {
              description: "Bearer token missing.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "403": {
              description: "Bearer token invalid.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "404": {
              description: "No such asset.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
      "/api/search": {
        get: {
          operationId: "searchAssets",
          summary: "Search assets by meaning",
          description:
            "Semantic (embedding) search across brand images and video. Falls back " +
            "to a keyword substring match if no semantic index is available. An empty " +
            "query returns the most recent assets.",
          parameters: [
            {
              name: "q",
              in: "query",
              required: false,
              description:
                "Natural-language query, e.g. \"cosy autumn bouquet\". Omit or leave " +
                "empty to browse newest-first.",
              schema: { type: "string" },
            },
            {
              name: "cursor",
              in: "query",
              required: false,
              description:
                "Opaque pagination cursor returned as `nextCursor` by a previous call.",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Matching assets, ranked by relevance.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/SearchResponse" },
                },
              },
            },
            "500": {
              description: "Search failed.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
      "/api/collections": {
        get: {
          operationId: "listCollections",
          summary: "List saved collections",
          description:
            "Returns lightweight summaries of every saved collection, newest first.",
          responses: {
            "200": {
              description: "Collection summaries.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["collections"],
                    properties: {
                      collections: {
                        type: "array",
                        items: {
                          $ref: "#/components/schemas/CollectionSummary",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: "createCollection",
          summary: "Create a shareable collection",
          description:
            "Creates a collection from a set of asset ids and returns its id. The " +
            "share URL is `/c/{id}`. Requires `Authorization: Bearer <token>` only " +
            "when the deployment sets API_WRITE_TOKEN.",
          security: [{ bearerAuth: [] }, {}],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["assetIds"],
                  properties: {
                    name: {
                      type: "string",
                      description: "Human-friendly collection name.",
                    },
                    assetIds: {
                      type: "array",
                      minItems: 1,
                      items: { type: "string" },
                      description:
                        "Notion page ids of the assets to include (the `id` field " +
                        "from search results).",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Collection created.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["id"],
                    properties: {
                      id: {
                        type: "string",
                        description: "Collection id; share at /c/{id}.",
                      },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Invalid body or no assets selected.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "401": {
              description: "Bearer token required but missing.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "403": {
              description: "Bearer token invalid.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
      "/api/collections/{id}": {
        get: {
          operationId: "getCollection",
          summary: "Get a collection with its assets",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "The collection and its assets.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Collection" },
                },
              },
            },
            "404": {
              description: "No such collection.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
        patch: {
          operationId: "renameCollection",
          summary: "Rename a collection",
          description:
            "Updates a collection's name. Requires `Authorization: Bearer " +
            "<token>` only when the deployment sets API_WRITE_TOKEN.",
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: {
                      type: "string",
                      description: "The new collection name (non-empty).",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Collection renamed.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["id", "name"],
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Empty or invalid name.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "401": {
              description: "Bearer token required but missing.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "403": {
              description: "Bearer token invalid.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
        delete: {
          operationId: "deleteCollection",
          summary: "Delete a collection",
          description:
            "Deletes (archives) a collection. The linked assets are not " +
            "affected. Requires `Authorization: Bearer <token>` only when the " +
            "deployment sets API_WRITE_TOKEN.",
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Collection deleted.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["ok"],
                    properties: { ok: { type: "boolean" } },
                  },
                },
              },
            },
            "401": {
              description: "Bearer token required but missing.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "403": {
              description: "Bearer token invalid.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
      schemas: {
        Asset: {
          type: "object",
          required: ["id", "title", "url", "description", "mediaType", "driveLink"],
          properties: {
            id: { type: "string", description: "Notion page id of the asset." },
            title: { type: "string" },
            url: {
              type: "string",
              description:
                "CDN preview image URL. May be empty for videos / rows with no preview.",
            },
            description: { type: "string" },
            mediaType: {
              type: "string",
              enum: ["image", "video", "other"],
            },
            driveLink: {
              type: "string",
              description: "Link to the original file (fallback when no preview URL).",
            },
          },
        },
        SearchResponse: {
          type: "object",
          required: ["results", "nextCursor"],
          properties: {
            results: {
              type: "array",
              items: { $ref: "#/components/schemas/Asset" },
            },
            nextCursor: {
              type: ["string", "null"],
              description: "Cursor for the next page, or null when exhausted.",
            },
          },
        },
        Collection: {
          type: "object",
          required: ["id", "name", "items"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            items: {
              type: "array",
              items: { $ref: "#/components/schemas/Asset" },
            },
          },
        },
        CollectionSummary: {
          type: "object",
          required: ["id", "name", "assetCount", "partialCount", "createdTime"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            assetCount: { type: "integer" },
            partialCount: {
              type: "boolean",
              description: "True when the real count exceeds assetCount.",
            },
            createdTime: { type: "string", format: "date-time" },
          },
        },
        PersonTag: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            consent: {
              type: "boolean",
              description: "Consent to appear in published material.",
            },
          },
        },
        Rights: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["internal", "licensed", "restricted"],
            },
            notes: { type: "string" },
          },
        },
        SimilarAsset: {
          type: "object",
          required: ["id", "url", "distance"],
          properties: {
            id: { type: "string" },
            url: { type: "string" },
            distance: {
              type: "integer",
              description: "pHash Hamming distance (lower = more similar; 0–6 ≈ same shot).",
            },
          },
        },
        ManifestEntry: {
          type: "object",
          required: [
            "id",
            "title",
            "url",
            "description",
            "mediaType",
            "driveLink",
            "context",
            "people",
            "product",
            "location",
            "shoot",
            "credit",
            "rights",
            "tags",
            "source",
            "uploaded_by",
            "uploaded_at",
            "sha256",
            "phash",
          ],
          properties: {
            id: { type: "string", description: "Notion page id of the asset." },
            title: { type: "string", description: "CDN filename." },
            url: { type: "string", description: "Permanent CDN URL." },
            description: {
              type: "string",
              description: "AI-classifier description (the enrichment channel).",
            },
            mediaType: { type: "string", enum: ["image", "video", "other"] },
            driveLink: { type: "string" },
            context: {
              type: "string",
              description: "Verbatim human description — never overwritten by AI.",
            },
            people: {
              type: "array",
              items: { $ref: "#/components/schemas/PersonTag" },
            },
            product: { type: "string" },
            location: { type: "string" },
            shoot: { type: "string" },
            credit: { type: "string" },
            rights: { $ref: "#/components/schemas/Rights" },
            tags: { type: "array", items: { type: "string" } },
            source: { type: "string" },
            uploaded_by: { type: "string" },
            uploaded_at: { type: "string" },
            sha256: { type: "string" },
            phash: { type: "string" },
            status: {
              type: "string",
              enum: ["processing", "ready"],
              description: "Search-indexing status for this asset.",
            },
          },
        },
        UploadedAsset: {
          allOf: [
            { $ref: "#/components/schemas/ManifestEntry" },
            {
              type: "object",
              properties: {
                similar: {
                  type: "array",
                  description:
                    "Near-duplicates found at upload (advisory — offer \"use the existing one instead?\").",
                  items: { $ref: "#/components/schemas/SimilarAsset" },
                },
              },
            },
          ],
        },
        DerivedObject: {
          type: "object",
          required: ["key", "existed"],
          properties: {
            key: { type: "string", description: "Storage key in the bucket." },
            url: {
              type: "string",
              description:
                "Public CDN URL (present when ASSET_DERIVED_CDN_BASE_URL is configured).",
            },
            existed: {
              type: "boolean",
              description: "True when the PUT was an idempotent no-op.",
            },
          },
        },
        Error: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "string" } },
        },
      },
    },
  };

  return NextResponse.json(spec);
}
