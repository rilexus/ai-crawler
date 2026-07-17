# zwo20 self-healing crawler — prototype

A working prototype of the pipeline discussed: LLM builds a schema.org JSON-LD
+ a CSS selector map once, then a cheap script re-crawls periodically using
selectors only. The LLM is only invoked again when a selector breaks.

## Why this differs from the original idea

The original idea proposed storing CSS selectors *inside* the JSON-LD file.
This prototype keeps them separate on purpose:

- `sites/<slug>/schema.jsonld` — a **valid, publishable** schema.org document
  per site. Nothing crawler-specific in it (aside from a small `_meta` block
  for bookkeeping). Generated automatically on a site's first crawl if it
  doesn't exist yet (see `schema.js`).
- `selector-map.json` — the crawler's own state: which selector(s) map to
  which JSON-LD path, what type of value is expected, whether changes are
  safe to auto-apply, and when each field was last verified.

Mixing the two would mean shipping non-standard keys inside a document
that's supposed to be machine-readable by search engines and other
consumers — and it can't cleanly express "this is a list, here's the
container selector and the item selector," which several fields need.

## Files

| File | Purpose |
|---|---|
| `sites/<slug>/schema.jsonld` | The public, standards-compliant output, one per site |
| `sites/<slug>/selector-map.json` | Field → selector(s) → validation rules → state, one per site |
| `crawler.js` | Main loop: extract → validate → diff → apply or queue repair |
| `repair.js` | Runs only on failure. LLM-assisted (needs `ANTHROPIC_API_KEY`) with an offline heuristic fallback so this demo runs without one |
| `fixtures/page-snapshot-v1.html` | Synthetic baseline page |
| `fixtures/page-snapshot-v2.html` | Synthetic "redesign" — some classes/hooks renamed, to exercise the fallback and repair paths |
| `logs/change-log.json` | Every value change ever detected, with timestamps and whether it was auto-applied |
| `logs/repair-queue.json` | Every repair attempt, resolved or not |

**Note on fixtures:** these are synthetic stand-ins, not a real capture of
zwo20.de's DOM. I never had access to the live site's actual HTML/class
names in this environment (`web_fetch` only returns markdown-converted
content, not raw markup, and the sandbox's network allowlist doesn't
include `zwo20.de` for direct fetching). The fixtures are built from the
content I *did* observe (real phone number, real PDF URLs, real address),
wrapped in plausible Wix-style hashed classes, so the extraction/diff/repair
logic can actually run and be verified — but they are not proof of what
selectors would work against the real page today.

## Run it

```bash
npm install
node crawler.js fixtures/page-snapshot-v1.html   # baseline
node crawler.js fixtures/page-snapshot-v1.html   # idempotent — no changes
node crawler.js fixtures/page-snapshot-v2.html   # simulated redesign
```

Each run prints a summary: which fields verified cleanly, which changed
and were auto-applied, which changed but were flagged for review, and
which needed a repair attempt.

## What the redesign run demonstrates

`page-snapshot-v2.html` renames several CSS classes and restructures the
address and opening-hours markup, while leaving `href`/`alt`-based
attributes untouched. Result:

- **`telephone`, `email`, PDF links, social links** — untouched, because
  they were matched via `a[href^='tel:']` etc., not class names. This is
  the "attribute selectors survive redesigns" point from earlier in this
  conversation, now actually verified rather than asserted.
- **`logoImage`** — primary selector (`img[alt='Zwo20 Logo']`) broke
  because the alt text changed, but the fallback (`header img`) caught it.
  Selector auto-healed via the fallback chain, no LLM needed.
- **`streetAddress` / `postalCode` / `addressLocality`** — all selectors
  failed, repair was attempted, and the offline heuristic *couldn't*
  confidently parse the new comma-separated address format. Correctly
  refused to guess — these stay at their last-known-good values in
  `schema.jsonld` and sit in `repair-queue.json` as `resolved: false`
  for a human (or a real LLM call) to fix.
- **`openingHoursRaw`** — repaired successfully (found via the surviving
  `data-hook` attribute), but because this field is marked
  `autoUpdate: false`, the new value is logged to `change-log.json` for
  review rather than silently overwriting the structured
  `openingHoursSpecification` in the public schema. Free-text hours can't
  be safely turned into structured day/time data without a judgment call.

That last point is the risk-gating mechanism discussed earlier: fields
where a wrong auto-apply would be embarrassing or misleading (opening
hours, prices, anything structured from free text) are opt-in for
auto-update; everything else defaults to safe, mechanical fields
(phone, email, URLs) where a matched-and-validated selector is trustworthy
enough to apply automatically.

## Moving this to production

1. **Replace `loadPageFromFile` with real page loading.** `crawler.js`
   has a `loadPageFromUrl` stub — implement it with Playwright
   (`page.goto()` + `page.content()`), not a plain `fetch()`. Wix (like
   most modern site builders) renders content client-side; a static GET
   won't see the final DOM, the same limitation I hit trying to inspect
   the real site from this environment.
2. **Wire up `ANTHROPIC_API_KEY`** in `repair.js` — the LLM code path is
   already written (`proposeSelectorsWithClaude`), it just wasn't
   exercised in this run since no key is configured in the sandbox. It
   already tests every candidate against live HTML before trusting it, so
   a hallucinated selector can't silently corrupt data — it just fails
   validation and falls through.
3. **Delete or heavily upgrade the heuristic fallback** — it exists only
   so this prototype runs without credentials or network access. It's
   intentionally naive (see the address-field failure above) and
   shouldn't be relied on for anything beyond very simple patterns.
4. **Move `selector-map.json` + logs into a real database** once crawling
   more than one site — a flat file works for a demo, not for fleet
   management, concurrent runs, or querying repair history across sites.
5. **Add a human-approval gate before publishing** the repaired
   `schema.jsonld` if it's being served live (e.g. injected into the
   actual site's `<head>`), not just diffed for review. This prototype
   writes directly to disk; a production version should stage changes
   and require a merge step for anything not on the auto-update allowlist.
6. **Respect `robots.txt` and rate limits** before crawling any real,
   third-party site on a schedule.
