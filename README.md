# ai-crawler

A fluent workflow builder for LLM-assisted web extraction: declare entities,
fields, nested objects/arrays, and classifications for a page, and the LLM
proposes CSS selectors for each one. Every candidate selector is verified by
actually running it against the page HTML with `cheerio` before it's trusted
— the LLM never gets to just assert a value.

The LLM calls a **local, OpenAI-compatible endpoint** (e.g. LM Studio) via the
`ai` SDK's `createOpenAICompatible`, not a hosted provider. Configure it in
`.env`:

```dotenv
MODEL_PROVIDER_URL=http://localhost:<port>   # LM Studio's OpenAI-compatible server
MODEL_NAME=<model-id-loaded-in-lm-studio>
```

`npm run dev` loads `.env` via `tsx --env-file=.env`.

## How it works

`index.js` declares one or more entities to extract via the fluent builder in
`extractor.js`:

```js
client.extract({
  url: "...",
  name: "Restaurant",
  extraction: (builder) =>
    builder
      .entity("Restaurant")
      .field("name", "The name of the restaurant on the page", "string")
      .field("review", "The reviews of the restaurant", "array", (builder) => {
        builder
          .entity("Review")
          .field("reviewBody", "The text of the review", "string")
          .classify("sentiment", "Content tone", [/* ... */]);
      }),
});
```

- `.field(name, description, "string")` — a leaf value.
- `.field(name, description, "object", (builder) => ...)` — a single nested
  entity (e.g. a comment's author).
- `.field(name, description, "array", (builder) => ...)` — a repeating list
  (e.g. reviews, or comments on a review); the LLM is asked separately for a
  **container selector** that matches every repeating item, and nested fields
  are resolved once per matched item.
- `.classify(type, description, options)` — a free-text classification
  (e.g. sentiment) resolved by asking the LLM to pick one of the given
  options, based on the entity's already-extracted field values.

Running a workflow is two steps:

1. **`create()`** — walks the field tree (`assignSelectorCandidates`) and asks
   the LLM for candidate CSS selectors per leaf field, and a container
   selector per array field (recursing into the first matched item's HTML for
   that array's nested fields).
2. **`run()`** — walks the field tree again (`resolveFields`), this time
   against a live `cheerio` DOM: resolving each leaf via the first candidate
   selector that actually matches, iterating array containers to produce one
   result object per item, and running classification prompts per entity.
   Results are persisted to `schemas/<url>/<name>-values.json`; the field
   definitions (including the selector candidates found) are persisted to
   `schemas/<url>/<name>-schema.json`.

Both `create()` and `run()` currently read `fixtures/restaurant-snapshot-v1.html`
regardless of the URL passed to `.extract()` — fetching the live page via
`loadPageFromUrl` is stubbed out (commented) pending that integration.

## Files

| File | Purpose |
| --- | --- |
| `extractor.js` | The workflow builder: `SchemaBuilder`/`CrawlerClient`, selector-candidate discovery, and field resolution |
| `index.js` | Entry point: declares the `Restaurant` entity (with nested `review`/`comment`/`author` fields) to extract |
| `browser/index.js` | Headless-browser page loading (Puppeteer locally, `@sparticuz/chromium-min` on Linux/serverless) and PDF snapshotting — not yet wired up (see below) |
| `fixtures/restaurant-snapshot-v1.html` | Fixture the workflow builder currently reads instead of a live page |
| `schemas/<url>/<name>-schema.json` | Field definitions + discovered selector candidates for one declared entity |
| `schemas/<url>/<name>-values.json` | The values resolved for that entity on the last `run()` |

## Run it

```bash
npm install
npm run dev
```

## Known gaps / moving this further toward production

1. **Fetch the live page.** `create()`/`run()` both hardcode the fixture file;
   swap in `loadPageFromUrl` (already imported in `extractor.js`) once a real
   crawl target is ready.
2. **No selector-verification-on-reuse loop yet.** Selector candidates are
   discovered once per `create()` and trusted as-is by `run()` — there's no
   re-verification or repair path if a selector stops matching on a later run.
3. **Finish cleaning up after the earlier, since-removed prototype** (a
   self-healing selector-map crawler with its own schema/selector-map/repair
   cycle): `repair.js`, `fixtures/page-snapshot-v2.html`, the `crawl` script,
   and the stale `package.json` `main`/`description` are gone/updated, but
   `browser/index.js`, `logs/`, and `sites/` are still unreferenced leftovers
   from it.
4. **Respect `robots.txt` and rate limits** before crawling any real,
   third-party site on a schedule.
5. **Own or vendor `CHROMIUM_PACK_URL`** (`browser/index.js`) — it currently
   points at an external bucket for the Linux/serverless Chromium binary.
