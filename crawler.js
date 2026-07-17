#!/usr/bin/env node
/**
 * zwo20 crawler prototype
 * --------------------------------------------------------------
 * Reads selector-map.json, runs each field's selectors against the
 * current page DOM, validates the extracted value, and either:
 *   - updates schema.jsonld (if the value changed and autoUpdate=true)
 *   - flags it for human review (if autoUpdate=false and it changed)
 *   - queues a repair job (if no selector produced a valid value)
 *
 * In production, `loadPage(url)` should use Playwright/Puppeteer,
 * since most modern sites (including this one, built on Wix) render
 * content client-side. This prototype reads a static HTML fixture
 * instead, since the sandbox this was built in can't reach the live
 * site or download a headless-browser binary. Swap `loadPageFromFile`
 * for `loadPageFromUrl` (stubbed below) to go live.
 * --------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const { repairField } = require("./repair");
const { generateSchema } = require("./schema");
const { generateSelectors } = require("./selectors");
const { loadPageFromUrl } = require("./browser");

const ROOT = __dirname;
const SITES_DIR = path.join(ROOT, "sites");
const CHANGE_LOG_PATH = path.join(ROOT, "logs", "change-log.json");
const REPAIR_QUEUE_PATH = path.join(ROOT, "logs", "repair-queue.json");

// ---------- per-site paths ----------
// Each site gets its own directory (sites/<slug>/) so schema.jsonld and
// selector-map.json never clash between sites being crawled.
function slugifyUrl(url) {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function getSiteDir(url) {
  return path.join(SITES_DIR, slugifyUrl(url));
}

function getSiteSchemaPath(url) {
  return path.join(getSiteDir(url), "schema.jsonld");
}

function getSiteSelectorMapPath(url) {
  return path.join(getSiteDir(url), "selector-map.json");
}

// ---------- validation rules ----------
const VALIDATORS = {
  phone: (v) => /^\+?[\d\s\-()]{6,}$/.test(v),
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  url: (v) => /^https?:\/\//.test(v),
  imageUrl: (v) => /^https?:\/\/.+\.(png|jpe?g|webp|gif)/i.test(v),
  postalCode: (v) => /^\d{4,6}$/.test(v.trim()),
  text: (v) => typeof v === "string" && v.trim().length > 0,
  openingHoursText: (v) => typeof v === "string" && v.trim().length > 0,
};

function validate(type, value) {
  const fn = VALIDATORS[type];
  if (!fn) return true; // unknown type: don't block, just pass through
  return fn(value);
}

// ---------- extraction ----------
function extractWithSelector($, selector, extract) {
  const el = $(selector).first();
  if (!el || el.length === 0) return null;

  if (extract === "text") {
    const t = el.text().trim();
    return t.length ? t : null;
  }
  if (extract.startsWith("attr:")) {
    const attr = extract.split(":")[1];
    const val = el.attr(attr);
    return val || null;
  }
  return null;
}

function normalizeByType(type, raw) {
  if (raw == null) return null;
  switch (type) {
    case "phone":
      // tel: links come through as "tel:+4985198848840"; strip scheme only.
      // (A production version should also normalize separators/spacing
      // before diffing, so "+49 851 988...” vs "+49-851-988..." isn't
      // treated as a content change — left as raw here for readability.)
      return raw.replace(/^tel:/, "");
    case "email":
      return raw.replace(/^mailto:/, "");
    default:
      return raw;
  }
}

// ---------- page loading ----------
function loadPageFromFile(filePath) {
  const html = fs.readFileSync(filePath, "utf-8");
  return cheerio.load(html);
}

// ---------- JSON-LD path helpers ----------
// Supports simple dot paths with array indices, e.g. "hasMenu[0].url"
function getPath(obj, pathStr) {
  const parts = pathStr.replace(/\[(\d+)\]/g, ".$1").split(".");
  return parts.reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function setPath(obj, pathStr, value) {
  const parts = pathStr.replace(/\[(\d+)\]/g, ".$1").split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

// ---------- main crawl routine ----------
async function crawlOnce({ url }) {
  const { page, html } = await loadPageFromUrl(url);

  const siteDir = getSiteDir(url);
  fs.mkdirSync(siteDir, { recursive: true });

  const schemaPath = getSiteSchemaPath(url);
  let schema;
  if (fs.existsSync(schemaPath)) {
    schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  } else {
    console.log(
      `  [schema] no schema.jsonld found for this site — generating one at sites/${slugifyUrl(url)}/schema.jsonld`,
    );
    schema = await generateSchema({ url, html });
    fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
  }

  const selectorMapPath = getSiteSelectorMapPath(url);
  let selectorMap;
  if (fs.existsSync(selectorMapPath)) {
    selectorMap = JSON.parse(fs.readFileSync(selectorMapPath, "utf-8"));
  } else {
    console.log(
      `  [selector-map] no selector-map.json found for this site — creating an empty one at sites/${slugifyUrl(url)}/selector-map.json`,
    );
    selectorMap = await generateSelectors({ schema, page });
    fs.writeFileSync(selectorMapPath, JSON.stringify(selectorMap, null, 2));
  }

  const changeLog = fs.existsSync(CHANGE_LOG_PATH)
    ? JSON.parse(fs.readFileSync(CHANGE_LOG_PATH, "utf-8"))
    : [];
  const repairQueue = fs.existsSync(REPAIR_QUEUE_PATH)
    ? JSON.parse(fs.readFileSync(REPAIR_QUEUE_PATH, "utf-8"))
    : [];

  const runTimestamp = new Date().toISOString();
  const summary = {
    verified: [],
    updated: [],
    flaggedForReview: [],
    repairQueued: [],
  };

  for (const field of selectorMap.fields) {
    const allSelectors = [
      ...field.selectors,
      ...(field.fallbackSelectors || []),
    ];
    let rawValue = null;
    let matchedSelector = null;

    for (const sel of allSelectors) {
      try {
        const candidate = extractWithSelector($, sel, field.extract);
        if (
          candidate &&
          validate(field.type, normalizeByType(field.type, candidate))
        ) {
          rawValue = candidate;
          matchedSelector = sel;
          break;
        }
      } catch (err) {
        // invalid selector syntax etc. — treat as a miss, keep trying fallbacks
        continue;
      }
    }

    if (rawValue == null) {
      // Nothing worked — queue for LLM-assisted repair.
      const job = {
        fieldId: field.id,
        jsonldPath: field.jsonldPath,
        queuedAt: runTimestamp,
        reason: "no selector (primary or fallback) produced a valid value",
      };
      repairQueue.push(job);
      summary.repairQueued.push(field.id);

      // Fire the repair attempt (LLM-assisted or heuristic fallback — see repair.js)
      const repairResult = await repairField(field, html);
      if (repairResult && repairResult.selector && repairResult.value != null) {
        console.log(
          `  [repair] ${field.id}: candidate selector "${repairResult.selector}" ` +
            `(confidence ${repairResult.confidence}) -> "${repairResult.value}"`,
        );
        field.selectors = [repairResult.selector, ...field.selectors];
        field.lastVerified = runTimestamp;
        job.resolved = true;
        job.resolvedSelector = repairResult.selector;
        job.resolvedAt = runTimestamp;

        // Even a repaired selector goes through the autoUpdate gate below.
        // (Diff first, THEN let applyValue update lastRawValue — setting it
        // beforehand would make the field diff against itself and hide the change.)
        applyValue(
          field,
          schema,
          repairResult.value,
          runTimestamp,
          changeLog,
          summary,
        );
      } else {
        console.log(
          `  [repair] ${field.id}: no candidate selector could be validated — needs human review`,
        );
        job.resolved = false;
      }
      continue;
    }

    const normalized = normalizeByType(field.type, rawValue);
    field.lastVerified = runTimestamp;
    summary.verified.push(field.id);

    if (matchedSelector !== field.selectors[0]) {
      console.log(
        `  [fallback used] ${field.id}: primary selector missed, "${matchedSelector}" worked`,
      );
    }

    applyValue(field, schema, normalized, runTimestamp, changeLog, summary);
  }

  schema._meta.lastCrawled = runTimestamp;

  fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
  fs.writeFileSync(selectorMapPath, JSON.stringify(selectorMap, null, 2));
  fs.writeFileSync(CHANGE_LOG_PATH, JSON.stringify(changeLog, null, 2));
  fs.writeFileSync(REPAIR_QUEUE_PATH, JSON.stringify(repairQueue, null, 2));

  return summary;
}

function applyValue(field, schema, newValue, timestamp, changeLog, summary) {
  // autoUpdate fields are diffed against the live public schema (that's what
  // they're allowed to write to). Non-autoUpdate fields are diffed against
  // their own last-seen value in the selector map, since they're never
  // written into the schema automatically — comparing against schema would
  // always show a "change" (schema stays null/stale forever otherwise).
  const currentValue = field.autoUpdate
    ? getPath(schema, field.jsonldPath)
    : field.lastRawValue;
  const changed = currentValue !== newValue;

  if (!changed) {
    return;
  }

  const entry = {
    fieldId: field.id,
    jsonldPath: field.jsonldPath,
    from: currentValue,
    to: newValue,
    detectedAt: timestamp,
    autoApplied: !!field.autoUpdate,
  };

  if (field.autoUpdate) {
    setPath(schema, field.jsonldPath, newValue);
    summary.updated.push(field.id);
  } else {
    summary.flaggedForReview.push(field.id);
    entry.note = field.note || "flagged: autoUpdate disabled for this field";
  }

  field.lastRawValue = newValue;
  changeLog.push(entry);
}

// ---------- CLI entry ----------
if (require.main === module) {
  const url = process.argv[2];
  console.log(`Crawling fixture: ${url}\n`);
  crawlOnce({ url }).then((summary) => {
    console.log("\n--- Run summary ---");
    console.log(JSON.stringify(summary, null, 2));
  });
}

module.exports = { crawlOnce };
