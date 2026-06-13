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
Apps    ──▶ /api/assets (POST) ──▶ dedup ──▶ R2 (CDN) + Manifest row ──▶ searchable in seconds
Anyone¹ ──▶ /api/assets/<id> (PATCH) ──▶ backfill human context ──▶ re-embedded
Browser ──▶ /api/collections (POST) ──▶ creates a row in the Collections DB
Browser ──▶ /collections ──▶ lists saved collections (GET /api/collections)
Anyone  ──▶ /c/<collection-id> ──▶ server-renders the saved assets (live Notion)
Agents  ──▶ /openapi.json ──▶ discover + call the JSON API above

¹ with the ASSET_LIBRARY_TOKEN bearer token
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
| `/api/assets`            | POST   | multipart: `file` + metadata       | `201` manifest entry / `200` deduped | bearer² |
| `/api/assets/{id}`       | GET    | —                                  | full manifest entry incl. status     | none |
| `/api/assets/{id}`       | PATCH  | `{ context?, people?, … }`         | the updated manifest entry           | bearer² |
| `/api/derived/{ns}/{name}` | PUT  | raw bytes                          | `{ key, url?, existed }`             | bearer² |
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

² **Asset writes are never open.** `POST /api/assets` and `PATCH
/api/assets/{id}` require `Authorization: Bearer <ASSET_LIBRARY_TOKEN>` and
return 503 until that variable is set. Browser clients never hold the token —
consumer apps (e.g. the social builder) proxy uploads through their own
servers, the same way they already proxy search.

## Uploading assets

`POST /api/assets` is how images enter the library from anywhere — a file
picker in the social builder, the brand-photographer skill, or any agent with
plain HTTP. The response carries a **permanent CDN URL** that is searchable
within seconds.

```bash
curl -X POST "https://<host>/api/assets" \
  -H "Authorization: Bearer $ASSET_LIBRARY_TOKEN" \
  -F file=@photo.jpg \
  -F context="Kellie tying the morning's stems, Melbourne studio, June shoot" \
  -F 'people=[{"name":"Kellie","consent":true}]' \
  -F product=Osaka -F location="Melbourne studio" -F source=social-builder
```

Accepted: jpeg / png / webp / heic (HEIC is transcoded to JPEG), max 25 MB.
Optional metadata fields: `context`, `people` (JSON, with per-person consent),
`product`, `location`, `shoot`, `credit`, `rights`
(`internal`/`licensed`/`restricted`), `tags` (JSON array), `source`,
`uploaded_by`, `on_similar` (`accept`/`reject`).

- **Exact dedup (hard guarantee).** The SHA-256 of the original bytes is
  stored on every entry. Re-uploading the same file — any filename — returns
  `200 { deduped: true, asset }` with the same asset id; the submitted context
  is **merged** in (freeform context appended, people/tags unioned, scalars
  filled only if empty). A re-upload is a context contribution, not an error.
- **Near-duplicates (advisory).** A 64-bit perceptual hash catches re-exports,
  resizes, light crops and format conversions. By default the upload succeeds
  and the response lists matches under `similar: [{id, url, distance}]` so the
  client can offer "use the existing one instead?". Send `on_similar=reject`
  to get a `409` with the matches instead (for agents that should defer to
  existing assets).
- **Human context beats the classifier.** The human fields are stored verbatim
  in their own Notion properties, lead the embedding text, and are never
  touched by AI enrichment (which owns `Overall Description`). A query naming
  a person or product also boosts those assets directly, not just via
  embedding similarity.
- **AI manifesting on upload.** When a Gemini key is configured (see
  `GEMINI_API_KEY`), each uploaded photo is run through a Gemini vision model
  that fills the AI channel — `Overall Description`, `Content Type`, `Mood
  Tone`, `Visual Tags`, `Products / Flowers`, `Setting / Location`, `Usable
  For` — exactly the fields the offline brand-asset-manifesting skill produces.
  It is best-effort: if the key is unset or a call fails, the upload still
  succeeds, just without enrichment. Human fields are never overwritten.
- **Backfill.** `PATCH /api/assets/{id}` accepts the same metadata fields
  (no file): add `{"people":[{"name":"Kellie"}]}` to a years-old Drive-synced
  asset and it becomes findable by "Kellie". The entry is re-embedded on
  change.
- **Permanent serving.** Originals are stored at full resolution in R2 under a
  content-addressed key derived from the human context
  (`kellie-tying-stems-melbourne-studio-2lq873.jpg`) with
  `cache-control: public, max-age=31536000, immutable` — never preview-style
  URLs that expire. Renditions (`?w=640|1080|1600|2048`) are the CDN worker's
  job; the API stores the original so no new asset inherits a size cap.

### Upload & review in the browser

Two pages put the upload path behind a UI for non-technical users:

- **`/upload`** — drag in (or pick) one or many photos at once. Each is
  uploaded, de-duplicated, stored, and AI-manifested as above, with per-file
  progress.
- **`/uploads`** — the completed-uploads review page: recent assets newest
  first, each an editable card. Add the things Gemini can't know — a person's
  name, the exact product, usage rights — and save; the entry is re-embedded so
  it's findable straight away.

Because asset writes are never open, these pages sign in once with the
`ASSET_LIBRARY_TOKEN` and exchange it (at `POST /api/session`) for an httpOnly
session cookie — the raw token never reaches client JavaScript. Programmatic
clients keep using the `Authorization: Bearer` header.

### Video → frames

`/upload` also accepts video. For each clip you choose how to ingest it:

- **Keep whole video** — the clip is stored as a single asset (`POST /api/videos`
  with `choice=video`), de-duplicated by SHA-256 like any upload.
- **Extract frames** (`choice=frames`) — kicks off a background job
  (`GET /api/videos/jobs/{id}` to poll) that turns a reel into still images:

  1. **Extract** candidate frames with ffmpeg (bundled via `ffmpeg-static`, so
     no system packages) — scene-change detection plus a uniform safety net.
  2. **Unique scenes** — cluster near-identical frames by perceptual hash so a
     held shot doesn't yield ten copies.
  3. **Best shot** — within each scene, pick the strongest frame. Sharpness is a
     cheap pre-filter; the actual pick is a Gemini frame score that weighs
     **subject prominence and composition**, falling back to sharpness when
     Gemini is unavailable.
  4. **Tidy up** — optional generative removal of captions / OSTs / reel chrome
     (Gemini image model, inpainting only — never invents subjects), then a
     conservative sharpen + colour/exposure pass via sharp.
  5. **File** — each surviving frame enters the same ingest path as a photo
     (dedup, store, Gemini manifest) and shows up on `/uploads` to tag.

  The primary use case is turning UGC-creator Instagram reels into clean,
  on-brand stills. Overlay removal needs a Google-native `GEMINI_API_KEY` (see
  `GEMINI_IMAGE_MODEL`); with only an OpenRouter key, cleanup is the
  conservative sharp pass alone.

  **Durable queue + background worker.** `POST /api/videos` (choice=frames)
  stores the clip and a job record in R2 and returns immediately; a separate
  **`video-worker`** service (`npm run worker:video`, a Render `type: worker` —
  see `render.yaml`) claims one job at a time and runs the whole pipeline off
  the web service. So a slow/large clip never blocks uploads, and jobs survive
  redeploys. The worker reuses the app's pipeline modules directly (run with
  `node --conditions=react-server --import tsx`, which neutralises their
  `import "server-only"`). One consequence of processing off-web: video frames
  become searchable after the next `reindex` (the `/uploads` review page lists
  them from Notion immediately, like Drive-synced assets). See the
  `VIDEO_QUEUE_*` env in `.env.local.example`.

Uploaded assets are inserted into the in-process search index immediately
(embedded on the spot, human-context first), so `GET /api/search?q=Kellie`
finds a fresh upload within seconds. The nightly re-index then folds them into
the prebuilt index permanently. Each entry carries `status`:
`ready` (searchable) or `processing` (indexed keyword-only until the next
re-index, e.g. if the embedding call failed).

### Derived objects (render cache tier)

`PUT /api/derived/<namespace>/<name>.<ext>` stores **objects derived from
brand assets** — e.g. the social builder's content-addressed render cache —
on the CDN, so warm thumbnails serve from the edge even while the app server
is asleep, and the cache survives deploys:

```bash
curl -X PUT "https://<host>/api/derived/render/<sha256>.png" \
  -H "Authorization: Bearer $ASSET_LIBRARY_TOKEN" \
  --data-binary @render.png
```

Derived objects are **not brand assets**: they live under a separate prefix
(`derived/`, override with `ASSET_DERIVED_PREFIX`), get no manifest row, no
dedup, no AI enrichment, and can never appear in `/api/search` — a rendered
post containing a photo of Kellie must not become a search hit for "Kellie".
PUTs are idempotent (the key is the caller's content hash): re-PUTting an
existing key is a no-op `200 { existed: true }`. Objects are stored with
immutable cache-control; eviction belongs to an R2 lifecycle rule (e.g.
delete after 90 days untouched) — a cold miss just re-renders. Set
`ASSET_DERIVED_CDN_BASE_URL` to have responses include the public `url`.

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

### 4. Enable the upload path (optional)

```bash
npm run setup:upload
```

Adds the human-context and dedup properties (`Context`, `People`, `Product`,
`Location`, `Shoot`, `Credit`, `Rights`, `Tags`, `Source`, `Uploaded By`,
`Uploaded At`, `SHA256`, `pHash`) to the Manifest data source. Idempotent —
existing properties are left untouched. Then set `ASSET_LIBRARY_TOKEN`,
`ASSET_CDN_BASE_URL` and the `R2_*` variables (write access) in `.env.local`
to switch `POST /api/assets` on.

### 5. Build the search index

```bash
npm run build:index
```

Embeds every Manifest asset into `src/data/asset-index.json` (metadata) and
`src/data/asset-index.vec.bin` (vectors). Re-run this whenever
the Manifest changes (new assets won't appear in search until you do). It's
cheap — embedding a few thousand assets costs well under a cent.

### 6. Run

```bash
npm run dev
```

Open <http://localhost:3000>.

> **Refreshing the index in production:** re-indexing is decoupled from app
> deploys. A **Render Cron Job** runs `npm run reindex` on a schedule
> (`build:index` → upload to Cloudflare R2 → ping the web service's deploy
> hook). App deploys themselves only run `fetch:index` to download the
> prebuilt index from R2 — they never re-embed, so a deploy can't be broken by
> an embeddings rate limit. To refresh on demand, trigger the cron job (or run
> `npm run reindex` locally with the R2 env vars set). The Notion data source
> query endpoint caps a single query at 10,000 results, so `build:index` shards
> Manifest reads by `created_time` month and recursively splits any shard that
> still hits the cap.

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
| `ASSET_LIBRARY_TOKEN`             | Bearer token for `POST /api/assets` / `PATCH /api/assets/{id}`; uploads stay disabled until set |
| `ASSET_CDN_BASE_URL`              | Public CDN base URL for uploaded originals (required for uploads) |
| `ASSET_STORAGE_PREFIX`            | R2 key prefix for uploads (default `figandbloom/asset-manifest/`) |
| `ASSET_R2_BUCKET`                 | Bucket for uploaded originals (default: `R2_BUCKET`) |
| `ASSET_MAX_BYTES`                 | Upload size limit (default 25 MB) |
| `ASSET_SIMILAR_DISTANCE`          | pHash Hamming distance counted as "similar" (default 6) |
| `ASSET_DERIVED_PREFIX`            | R2 key prefix for derived objects (default `derived/`) |
| `ASSET_DERIVED_CDN_BASE_URL`      | Optional public CDN base URL for derived objects (adds `url` to PUT responses) |
| `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` | Override model (default `text-embedding-3-small`, 512d) |
| `EMBEDDING_BATCH_SIZE`            | Build-time embedding batch size (default `64`)   |
| `EMBEDDING_THROTTLE_MS`           | Delay between embedding batches to avoid TPM limits (default `250`) |
| `EMBEDDING_MAX_RETRIES`           | Retries for transient embedding failures such as 429/5xx (default `8`) |
| `NOTION_MAX_RETRIES`              | Retries for transient Notion API failures such as 429/502/503/504 (default `6`) |
| `ASSET_INDEX_PATH`                | Metadata index path (default `src/data/asset-index.json`; vectors sit beside it as `.vec.bin`) |
| `R2_ACCOUNT_ID` / `R2_BUCKET`     | Cloudflare R2 account + bucket holding the prebuilt index |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 S3 API token (read-only for the web service, read/write for the cron job) |
| `R2_ENDPOINT` / `R2_REGION` / `R2_INDEX_PREFIX` | Optional R2 overrides (default endpoint from account id, region `auto`, no key prefix) |
| `RENDER_DEPLOY_HOOK_URL`          | Cron job only — web service deploy hook, pinged after a re-index |
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
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
     (the web service needs a **read/write** R2 token when asset uploads are
     enabled — it stores originals at runtime; read-only suffices if uploads
     stay off. The cron job always needs read/write.)
   - `ASSET_LIBRARY_TOKEN`, `ASSET_CDN_BASE_URL` (to enable `POST /api/assets`;
     run `npm run setup:upload` once first)
   - `RENDER_DEPLOY_HOOK_URL` (cron job only — the web service's deploy hook,
     so a fresh index goes live automatically after re-index)

   The non-secret ids (`NOTION_ASSETS_DATABASE_ID`,
   `NOTION_COLLECTIONS_PARENT_PAGE_ID`) are baked into the blueprint.

4. Deploy. Render runs `npm ci && npm run fetch:index && npm run build` — the
   prebuilt index is downloaded from R2 (non-fatal if absent), then the app is
   built and served with `next start -p $PORT`. `autoDeploy` is on, so pushes
   to the configured branch redeploy automatically.

5. The blueprint also creates an **`asset-index-reindex` cron job** that
   rebuilds the index and uploads it to R2 on a schedule (default daily at
   18:00 UTC; edit `schedule` in `render.yaml`). This is the only thing that
   talks to OpenAI/Notion for embeddings, and it retries rate limits with
   backoff so a transient `429` no longer fails anything.

> **First-time setup:** create the R2 bucket and an R2 API token in Cloudflare
> before the first deploy, then run the cron job once (Render dashboard →
> **Manual Run**) so the index exists in R2. Until then, search returns empty
> results (the app still builds and runs fine).

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
