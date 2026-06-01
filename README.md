# Asset Library

A simple search interface over the **Brand Asset Manifest** in Notion. Type a
query, see matching assets rendered in a masonry grid, select the ones you
want, and save them as a **shareable collection** you can send to an agency —
no login required.

Built with **Next.js (App Router) + TypeScript** and the official
**`@notionhq/client`** SDK. Plain CSS, no UI framework.

## How it works

```
Browser ──▶ /api/search ──▶ Notion (Manifest data source)  ──▶ masonry grid
Browser ──▶ /api/collections (POST) ──▶ creates a row in the Collections DB
Anyone  ──▶ /c/<collection-id> ──▶ server-renders the saved assets
```

- The Notion token lives only on the server (API routes + server components);
  it is never exposed to the browser.
- Each asset's image comes from the `Preview URL` property (your Cloudflare
  Workers CDN). The title comes from the `Asset` property.
- Search matches your query against the asset's description, visual tags,
  products, mood, location, etc. (see `searchableTextProps` in
  `src/lib/config.ts`). Only rows with `Asset Type = image` are returned.
- Collections are stored as rows in a dedicated **Asset Collections** Notion
  database, each with a relation to the selected Manifest rows. The Notion page
  id of that row _is_ the share URL, so it's a single source of truth you can
  also browse inside Notion.

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

### 4. Run

```bash
npm run dev
```

Open <http://localhost:3000>.

## Configuration reference

All configurable via environment variables (see `.env.local.example`):

| Variable                          | Purpose                                          |
| --------------------------------- | ------------------------------------------------ |
| `NOTION_TOKEN`                    | Integration token (server-only secret)           |
| `NOTION_ASSETS_DATABASE_ID`       | The Manifest database                            |
| `NOTION_ASSETS_DATA_SOURCE_ID`    | Optional; auto-resolved from the database id     |
| `NOTION_COLLECTIONS_DATABASE_ID`  | Set by `setup:collections`                       |
| `NOTION_COLLECTIONS_PARENT_PAGE_ID` | Where the Collections DB is created            |
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
   - `NOTION_COLLECTIONS_DATABASE_ID`
   - `NOTION_COLLECTIONS_DATA_SOURCE_ID`

   The non-secret ids (`NOTION_ASSETS_DATABASE_ID`,
   `NOTION_COLLECTIONS_PARENT_PAGE_ID`) are baked into the blueprint.

4. Deploy. Render runs `npm ci && npm run build` and serves with
   `next start -p $PORT`. `autoDeploy` is on, so pushes to the configured
   branch redeploy automatically.

The blueprint defaults to the **Singapore** region (closest to Australia) and
the **Starter** plan (always-on, no cold starts — important so agency share
links load instantly). Adjust `region`/`plan` in `render.yaml` if you prefer.
