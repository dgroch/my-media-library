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
        "Semantic search over the Brand Asset Manifest and shareable asset collections. " +
        "Reads are public. Creating a collection may require a bearer token if the " +
        "deployment sets API_WRITE_TOKEN.",
    },
    servers: [{ url: origin }],
    paths: {
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
