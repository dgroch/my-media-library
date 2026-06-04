# Asset Library

A simple search interface over the **Brand Asset Manifest** in Notion. Type a
query, see matching assets rendered in a masonry grid, select the ones you
want, and save them as a **shareable collection** you can send to an agency —
no login required.

Built with **Next.js (App Router) + TypeScript** and the official
**`@notionhq/client`** SDK. Plain CSS, no UI framework.

## How it works

```
build:index ──▶ Notion (all rows) ──▶ embed ──▶ src/data/asset-index.{json,vec.bin}
Browser ──▶ /api/search ──▶ embed query ──▶ rank index by meaning ──▶ grid
Browser ──▶ /api/collections (POST) ──▶ creates a row in the Collections DB
Browser ──▶ /collections ──▶ lists saved collections (GET /api/collections)
Anyone  ──▶ /c/<collection-id> ──▶ server-renders the saved assets (live Notion)
Agents  ──▶ /openapi.json ──▶ discover + call the JSON API above
```

- **Semantic search.** A build step (`npm run build:index`) reads every row in
  the Manifest, concatenates its descriptive fields (description, visual tags,
  products, mood, setting, scene beats, etc. — see `embeddingTextProps` in
  `src/lib/config.ts`) and embeds them with OpenAI into
  `src/data/` (small metadata JSON + a compact binary float32 vector blob). At
  query time the search box text is embedded and
  ranked against that index by cosine similarity, so "cosy autumn bouquet"
  finds the right shots even without exact keyword matches. If no index is
  present the app falls back to Notion's substring filter.
- **Images and video.** Media type is derived from the filename (we no longer
  rely on the often-unset `Asset Type` property, which previously hid assets).
  Images render from the `Preview URL` CDN. Videos in the Manifest have no
  public preview image, so they render as a "▶ Video" placeholder card showing
  the description and linking to the original (Google Drive).
- The Notion and OpenAI keys live only on the server; never exposed to the
  browser.
- Collections are stored as rows in a dedicated **Asset Collections** Notion
  database, each with a relation to the selected Manifest rows. The Notion page
  id of that row _is_ the share URL, so it's a single source of truth you can
  also browse inside Notion.

## API

The app exposes a small JSON API that other services — Claude tool use, an
agent, a cron job — can call directly. A machine-readable **OpenAPI 3.1** spec
is served at **`/openapi.json`**, so most agent frameworks can import the tools
without hand-written schemas.

| Endpoint                 | Method | Body / Query                       | Returns                              | Auth |
| ------------------------ | ------ | ---------------------------------- | ------------------------------------ | ---- |
| `/api/search`            | GET    | `?q=<text>&cursor=<opaque>`        | `{ results: Asset[], nextCursor }`   | none |
| `/api/collections`       | GET    | —                                  | `{ collections: CollectionSummary[] }` | none |
| `/api/collections`       | POST   | `{ name?, assetIds: string[] }`    | `{ id }` (share at `/c/{id}`)        | optional¹ |
| `/api/collections/{id}`  | GET    | —                                  | `{ id, name, items: Asset[] }`       | none |
| `/c/{id}`                | GET    | —                                  | server-rendered HTML share page      | none |
| `/openapi.json`          | GET    | —                                  | the OpenAPI 3.1 description          | none |

`Asset` is `{ id, title, url, description, mediaType, driveLink }`. An empty
`q` returns the most recent assets. Example:

```bash
curl "https://<host>/api/search?q=cosy%20autumn%20bouquet"
curl -X POST "https://<host>/api/collections" \
  -H 'content-type: application/json' \
  -d '{"name":"Spring campaign","assetIds":["<asset-id>","<asset-id>"]}'
```

¹ **Write auth is opt-in.** By default `POST /api/collections` is open, so the
no-login browser "Save collection" button works. Set `API_WRITE_TOKEN` in the
environment to require `Authorization: Bearer <token>` on that endpoint (for
deployments that expose the API to automation and want writes private). Reads
are always public. Note that enabling the token disables the in-browser save
button, since the browser has nowhere safe to hold the secret.

## Setup

### 1. Install

```bash
npm install
```

### 2. Configure Notion

```bash
cp .env.local.example .env.local
```

Then edit `.env.local`:

- `NOTION_TOKEN` — an internal integration token from
  <https://www.notion.so/my-integrations>.
- `NOTION_ASSETS_DATABASE_ID` — already defaulted to the Brand Asset Manifest.
- `OPENAI_API_KEY` — for semantic search embeddings
  (<https://platform.openai.com/api-keys>).

**Important:** in Notion, share the Manifest database (and its parent "Assets"
page) with your integration so it has read access.

### 3. Create the Collections database

```bash
npm run setup:collections
```

This creates an **Asset Collections** database under the "Assets" page and
writes `NOTION_COLLECTIONS_DATABASE_ID` / `NOTION_COLLECTIONS_DATA_SOURCE_ID`
back into `.env.local`. Because it's created under a page your integration can
already see, it inherits access automatically.

### 4. Build the search index

```bash
npm run build:index
```

Embeds every Manifest asset into `src/data/asset-index.json` (metadata) and
`src/data/asset-index.vec.bin` (vectors). Re-run this whenever
the Manifest changes (new assets won't appear in search until you do). It's
cheap — embedding a few thousand assets costs well under a cent.

### 5. Run

```bash
npm run dev
```

Open <http://localhost:3000>.

> **Refreshing the index in production:** the Render build runs `build:index`
> automatically on every deploy, so triggering a redeploy (or a Render Cron Job
> that hits the deploy hook) re-embeds the latest Manifest.

## Configuration reference

All configurable via environment variables (see `.env.local.example`):

| Variable                          | Purpose                                          |
| --------------------------------- | ------------------------------------------------ |
| `NOTION_TOKEN`                    | Integration token (server-only secret)           |
| `NOTION_ASSETS_DATABASE_ID`       | The Manifest database                            |
| `NOTION_ASSETS_DATA_SOURCE_ID`    | Optional; auto-resolved from the database id     |
| `NOTION_COLLECTIONS_DATABASE_ID`  | Set by `setup:collections`                       |
| `NOTION_COLLECTIONS_PARENT_PAGE_ID` | Where the Collections DB is created            |
| `OPENAI_API_KEY`                  | Embeddings key (build-time + query-time secret)  |
| `API_WRITE_TOKEN`                 | Optional; when set, requires a bearer token on `POST /api/collections` |
| `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` | Override model (default `text-embedding-3-small`, 512d) |
| `ASSET_INDEX_PATH`                | Metadata index path (default `src/data/asset-index.json`; vectors sit beside it as `.vec.bin`) |
| `NOTION_PROP_*`                   | Override property names if the schema changes    |

## Deploying (Render)

This repo ships a `render.yaml` blueprint. The app is a stateless Node web
service — Notion is the only backend, so there's no database or disk to
provision.

1. **Create the Collections database first** (locally), so you have its ids:

   ```bash
   npm run setup:collections
   ```

   Note the `NOTION_COLLECTIONS_DATABASE_ID` /
   `NOTION_COLLECTIONS_DATA_SOURCE_ID` it prints.

2. In Render: **New + → Blueprint**, point it at this repo. Render reads
   `render.yaml` and creates an always-on **Starter** web service.

3. When prompted, fill in the secret env vars (these are marked `sync: false`
   so they're never committed):
   - `NOTION_TOKEN`
   - `OPENAI_API_KEY`
   - `NOTION_COLLECTIONS_DATABASE_ID`
   - `NOTION_COLLECTIONS_DATA_SOURCE_ID`

   The non-secret ids (`NOTION_ASSETS_DATABASE_ID`,
   `NOTION_COLLECTIONS_PARENT_PAGE_ID`) are baked into the blueprint.

4. Deploy. Render runs `npm ci && npm run build:index && npm run build` (so the
   embedding index is rebuilt from the latest Manifest on every deploy) and
   serves with `next start -p $PORT`. `autoDeploy` is on, so pushes to the
   configured branch redeploy automatically.

The blueprint defaults to the **Singapore** region (closest to Australia) and
the **Starter** plan (always-on, no cold starts — important so agency share
links load instantly). Adjust `region`/`plan` in `render.yaml` if you prefer.

### Memory

The Starter instance has 512MB RAM. The search index is held in memory as one
compact float32 buffer: roughly `assets × EMBEDDING_DIMENSIONS × 4 bytes`
(e.g. ~10MB for 5,000 assets at 512d), which fits comfortably alongside the
Next.js runtime. If the Manifest grows very large and you approach the limit,
either lower `EMBEDDING_DIMENSIONS` (e.g. 256) and rebuild, or bump the Render
plan to a larger instance.
