# ai-crawler

LLM-authored schema.org JSON-LD + a CSS selector map, kept in sync by a cheap
periodic crawl. The LLM is only invoked again when a selector breaks (or, in
the newer workflow builder below, on every run — see caveats).

The repo currently contains **two separate pipelines** at different levels of
completeness:

1. **Selector-map crawler** (`crawler.js` + `schema.js` + `selectors.js` +
   `repair.js`) — the original self-healing design, now wired to load real
   pages via a headless browser.
2. **Extraction workflow builder** (`extractor.js` / `index.js`) — a newer,
   fluent API for declaring per-field extraction + classification jobs. Still
   a prototype: it reads a fixture file instead of a live URL and doesn't yet
   persist a reusable selector map.

Both call the same local LLM endpoint (see [LLM provider](#llm-provider)
below) rather than a hosted API.

## Design: why selectors live outside the JSON-LD

The selector-map crawler keeps two files per site, on purpose:

- `sites/<slug>/schema.jsonld` — a **valid, publishable** schema.org document.
  Nothing crawler-specific in it (aside from a small `_meta` block for
  bookkeeping). Generated automatically on a site's first crawl if it doesn't
  exist yet (`schema.js`).
- `sites/<slug>/selector-map.json` — the crawler's own state: which
  selector(s) map to which JSON-LD path, what type of value is expected,
  whether changes are safe to auto-apply, and when each field was last
  verified. Generated on first crawl too (`selectors.js`), by asking the LLM
  for candidate selectors and verifying each one against the live page before
  trusting it.

Mixing the two would mean shipping non-standard keys inside a document that's
supposed to be machine-readable by search engines and other consumers — and
it can't cleanly express "this is a list, here's the container selector and
the item selector," which several fields need.

## LLM provider

Both pipelines call a **local, OpenAI-compatible endpoint** (e.g. LM Studio)
via the `ai` SDK's `createOpenAICompatible`, not a hosted provider. Configure
it in `.env`:

```dotenv
MODEL_PROVIDER_URL=http://localhost:<port>   # LM Studio's OpenAI-compatible server
MODEL_NAME=<model-id-loaded-in-lm-studio>
```

`npm run crawl` / `npm run dev` both load `.env` via `tsx --env-file=.env`.

## Files

| File | Purpose |
| --- | --- |
| `crawler.js` | Selector-map pipeline entry point: loads a live page, extract → validate → diff → apply or queue repair |
| `schema.js` | Generates the initial `schema.jsonld` for a site the crawler hasn't seen before |
| `selectors.js` | Generates the initial `selector-map.json`: LLM proposes selectors, each candidate is verified against the live HTML before being kept |
| `repair.js` | Runs only when a field's selectors all fail. LLM proposes new candidates (validated against live HTML) with an offline heuristic fallback |
| `markdown.js` | Converts page HTML to clean Markdown via the LLM (not yet wired into `crawler.js`) |
| `browser/index.js` | Headless-browser page loading (Puppeteer locally, `@sparticuz/chromium-min` on Linux/serverless) and PDF snapshotting |
| `extractor.js` / `index.js` | Fluent workflow builder prototype: declare entities/fields/classifications per URL, extract, and persist to `schemas/` |
| `sites/<slug>/schema.jsonld` | Public, standards-compliant output, one per site (selector-map pipeline only) |
| `sites/<slug>/selector-map.json` | Field → selector(s) → validation rules → state, one per site (selector-map pipeline only) |
| `schemas/<url>/<name>-schema.json` | Output of the workflow-builder pipeline, one file per declared entity |
| `logs/change-log.json` | Every value change ever detected, with timestamps and whether it was auto-applied |
| `logs/repair-queue.json` | Every repair attempt, resolved or not |
| `fixtures/restaurant-snapshot-v1.html` | Fixture the workflow builder currently reads instead of a live page |
| `fixtures/page-snapshot-v2.html` | Leftover fixture from an earlier iteration of the selector-map pipeline; unused now that `crawler.js` loads live pages |

## Run it

```bash
npm install
```

**Selector-map pipeline** — takes a live URL, creates `sites/<slug>/` on first
run, then re-verifies on every subsequent run:

```bash
npm run crawl -- https://example.com
```

Prints a summary: which fields verified cleanly, which changed and were
auto-applied, which changed but were flagged for review, and which needed a
repair attempt.

**Workflow builder** — currently hardcoded to read
`fixtures/restaurant-snapshot-v1.html` regardless of the URLs passed to
`.extract()`; the URLs are recorded in the output but not yet fetched:

```bash
npm run dev
```

## Risk gating

Mechanical, attribute-anchored fields (phone, email, image/menu URLs) default
to `autoUpdate: true` — a selector that resolves and validates is trustworthy
enough to apply automatically. Fields that require a judgment call on free
text (opening hours, anything parsed rather than matched) default to
`autoUpdate: false`: a new value is logged to `change-log.json` for review
instead of silently overwriting the structured data in `schema.jsonld`.

## Known gaps / moving this further toward production

1. **Unify or retire one of the two pipelines.** Right now `crawler.js` and
   `extractor.js` duplicate the "extract fields, ask an LLM for selectors"
   idea with different data models and neither reads the other's output.
2. **Wire the workflow builder to live pages.** `extractor.js` still reads a
   fixture file (`create()`/`run()`) instead of calling `loadPageFromUrl`,
   and doesn't persist a selector map for reuse across runs.
3. **`markdown.js` is unused.** No caller wires it into either pipeline yet.
4. **Move `selector-map.json` + logs into a real database** once crawling
   more than one site at scale — flat files don't hold up for fleet
   management, concurrent runs, or querying repair history across sites.
5. **Add a human-approval gate before publishing** `schema.jsonld` if it's
   served live (e.g. injected into a site's `<head>`), rather than writing
   straight to disk on every crawl.
6. **Respect `robots.txt` and rate limits** before crawling any real,
   third-party site on a schedule.
7. **Own or vendor `CHROMIUM_PACK_URL`** (`browser/index.js`) — it currently
   points at an external bucket for the Linux/serverless Chromium binary.
