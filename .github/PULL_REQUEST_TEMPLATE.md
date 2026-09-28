## What

<!-- One or two sentences. What changes, and why? Link the issue if there is one. -->

## How

<!--
Key implementation notes and any tradeoff worth flagging in review. Call out
anything a reviewer would otherwise have to reverse-engineer from the diff.
-->

## Deployment notes

<!-- Delete what doesn't apply. Anything checked here must happen in order. -->

- [ ] Nothing required — merge and deploy
- [ ] Notion schema migration: `npm run setup:<name>` <!-- e.g. setup:upload, setup:smart-collections -->
- [ ] Requires a reindex: `npm run reindex`
- [ ] New or changed environment variables — names listed below, **never values**
- [ ] Affects the video worker / queue (`npm run worker:video`)
- [ ] Affects the Drive mirror (`npm run check:drive`)
- [ ] Changes the asset index format (check `build:index` and `fetch:index` agree)

Variable names added or changed:

<!-- e.g. NOTION_PROP_TAGS, ASSET_MAX_BYTES -->

## Verification

<!--
Prefer commands, queries, and observed output over "tested locally". If a
verification step is impractical, say which one and why — an honest gap is
easier to review than a checked box nobody believes.
-->

- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` passes
- [ ] Exercised against a real Notion workspace
- [ ] Checked the affected page(s) in a browser
- [ ] Migration run twice to prove it is idempotent <!-- if one was added -->

Evidence:

<!-- Paste the command and its output, a query and its count, a screenshot, etc. -->

## Risk

<!-- What could break, how wide is the blast radius, and how would you roll it back? -->

## Checklist

- [ ] No secrets, tokens, or `.env.local` contents are committed
- [ ] **Two-channel rule respected**: human fields (`Context`, `People`, `Product`, `Location`, `Shoot`, `Credit`, `Rights`, `Tags`, `Source`) are never written by the AI pipeline, and AI fields are never written by the human path
- [ ] Backward compatible — or the break is called out under Risk and in the deployment notes
- [ ] `README.md` updated if behaviour, setup, or the API surface changed
- [ ] `src/app/openapi.json/route.ts` updated if a public API route changed
