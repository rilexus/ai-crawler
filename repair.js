/**
 * repair.js
 * --------------------------------------------------------------
 * Called only when a field's selectors (primary + fallback) all fail
 * to produce a valid value — this is the expensive/slow path, meant
 * to run rarely, not on every crawl.
 *
 * Two modes:
 *  1. LIVE:   ask a local LLM (via LM Studio's OpenAI-compatible server at
 *             process.env.LLM_PROVIDER_URL/v1) to propose candidate CSS selectors
 *             for the field, then test each candidate against the actual
 *             page HTML locally before trusting it. The LLM never gets to
 *             just assert a value — its selector still has to actually
 *             resolve and validate.
 *  2. OFFLINE: a small heuristic fallback (pattern/keyword matching,
 *             no AI) so this prototype can run end-to-end without
 *             network access or credentials. Clearly separate from
 *             the LLM path so it's obvious which one produced a result.
 * --------------------------------------------------------------
 */

const cheerio = require("cheerio");
const { generateText } = require("ai");
const { createOpenAICompatible } = require("@ai-sdk/openai-compatible");

const lmstudio = createOpenAICompatible({
  name: "lmstudio",
  baseURL: `${process.env.MODEL_PROVIDER_URL}/v1`,
});

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
  if (!fn) return true;
  return fn(value);
}

/** Test a candidate selector against the live HTML and return its value if valid. */
function testCandidate($, field, candidate) {
  try {
    const el = $(candidate.selector).first();
    if (!el || el.length === 0) return null;

    let raw;
    if (candidate.extract === "text") raw = el.text().trim();
    else if (candidate.extract && candidate.extract.startsWith("attr:")) {
      raw = el.attr(candidate.extract.split(":")[1]);
    } else {
      raw = el.text().trim();
    }

    if (!raw) return null;
    const normalized =
      field.type === "phone"
        ? raw.replace(/^tel:/, "")
        : field.type === "email"
          ? raw.replace(/^mailto:/, "")
          : raw;

    if (!validate(field.type, normalized)) return null;
    return normalized;
  } catch (err) {
    return null; // malformed selector, e.g. from a hallucinated candidate
  }
}

/** LIVE mode: ask the local LLM (LM Studio) for candidate selectors. */
async function proposeSelectorsWithLLM(field, htmlSnippet) {
  const prompt = `You are repairing a broken CSS selector for a web scraper.
Field: "${field.id}" (expects a value of type "${field.type}").
Its previous selectors no longer match anything on the page, or the page changed.
Here is the current page HTML:
---
${htmlSnippet.slice(0, 12000)}
---
Propose up to 3 candidate CSS selectors that would extract this field's value today.
Prefer attribute-based selectors (href, src, alt) over class names, since class names
on this site are auto-generated and unstable.
Respond ONLY with JSON, no prose:
{"candidates": [{"selector": "...", "extract": "text|attr:href|attr:src", "confidence": 0.0-1.0}]}`;

  const { text } = await generateText({
    model: lmstudio(process.env.MODEL_NAME || "local-model"),
    maxOutputTokens: 500,
    prompt,
  });

  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return parsed.candidates || [];
  } catch (err) {
    return [];
  }
}

/**
 * OFFLINE heuristic fallback — no AI, no network.
 * Deliberately simple/naive: this exists so the prototype is runnable,
 * not as a replacement for the LLM path. It knows a handful of patterns
 * for this field set only.
 */
function heuristicCandidates(field, $) {
  const candidates = [];

  if (
    field.id === "streetAddress" ||
    field.id === "postalCode" ||
    field.id === "addressLocality"
  ) {
    // Look for any element whose text contains a 5-digit postal code pattern (DE)
    $("*").each((_, el) => {
      const t = $(el).text().trim();
      const m = t.match(
        /([A-Za-zäöüß.\- ]+\d+)\s*[—\-–]?\s*(\d{5})\s+([A-Za-zäöüß.\- ]+)/,
      );
      if (m && $(el).children().length === 0) {
        // leaf element containing "Street 12, 94032 City"-style text
        const selector = cssPathFor($, el);
        if (field.id === "streetAddress")
          candidates.push({
            selector,
            extract: "text",
            confidence: 0.55,
            _match: m[1].trim(),
          });
        if (field.id === "postalCode")
          candidates.push({
            selector,
            extract: "text",
            confidence: 0.55,
            _match: m[2].trim(),
          });
        if (field.id === "addressLocality")
          candidates.push({
            selector,
            extract: "text",
            confidence: 0.55,
            _match: m[3].trim(),
          });
      }
    });
  }

  if (field.id === "openingHoursRaw") {
    $("table, div").each((_, el) => {
      const t = $(el).text();
      if (
        /\d{1,2}[:.]\d{2}/.test(t) &&
        /(Uhr|geschlossen|\d{2}:\d{2})/.test(t)
      ) {
        candidates.push({
          selector: cssPathFor($, el),
          extract: "text",
          confidence: 0.5,
          _match: t.trim(),
        });
      }
    });
  }

  if (field.id === "logoImage") {
    $("header img, img[alt*='Logo' i]").each((_, el) => {
      candidates.push({
        selector: cssPathFor($, el),
        extract: "attr:src",
        confidence: 0.6,
      });
    });
  }

  return candidates;
}

/** Build a reasonably specific CSS path for an element (class-based, last resort). */
function cssPathFor($, el) {
  const $el = $(el);
  const tag = el.tagName;
  const cls = $el.attr("class");
  const dataHook = $el.attr("data-hook");
  if (dataHook) return `[data-hook='${dataHook}']`;
  if (cls) return `${tag}.${cls.split(" ")[0]}`;
  return tag;
}

async function repairField(field, fullHtml) {
  const $ = cheerio.load(fullHtml);

  // 1. Try LLM (local LM Studio server)
  const llmCandidates = await proposeSelectorsWithLLM(field, fullHtml);
  if (llmCandidates && llmCandidates.length) {
    const ranked = [...llmCandidates].sort(
      (a, b) => (b.confidence || 0) - (a.confidence || 0),
    );
    for (const c of ranked) {
      const value = testCandidate($, field, c);
      if (value != null) {
        return {
          selector: c.selector,
          value,
          confidence: c.confidence,
          source: "llm",
        };
      }
    }
  }

  // 2. Offline heuristic fallback (used if the LLM path found nothing usable)
  const heuristics = heuristicCandidates(field, $);
  const ranked = heuristics.sort(
    (a, b) => (b.confidence || 0) - (a.confidence || 0),
  );
  for (const c of ranked) {
    const value = testCandidate($, field, c);
    if (value != null) {
      return {
        selector: c.selector,
        value,
        confidence: c.confidence,
        source: "heuristic",
      };
    }
  }

  return null;
}

module.exports = { repairField };
