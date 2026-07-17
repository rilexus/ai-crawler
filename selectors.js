/**
 * selectors.js
 * --------------------------------------------------------------
 * Generates the initial selector-map.json for a site the crawler hasn't
 * seen before. Takes the schema.jsonld just produced by schema.js (ground
 * truth values) and the raw page HTML, asks a local LLM to propose CSS
 * selectors per field, then verifies every candidate against the actual
 * HTML — it has to resolve AND reproduce the value already trusted in
 * schema.jsonld — before it's kept. Same LLM-proposes/code-verifies split
 * as repair.js; runs once per site, same as schema.js.
 * --------------------------------------------------------------
 */

const cheerio = require("cheerio");
const { generateText } = require("ai");
const { createOpenAICompatible } = require("@ai-sdk/openai-compatible");

const lmstudio = createOpenAICompatible({
  name: "lmstudio",
  baseURL: `${process.env.MODEL_PROVIDER_URL}/v1`,
});

// Mirrors the VALIDATORS type set in crawler.js/repair.js — inferred from
// the JSON-LD path since schema.js doesn't tag fields with a type.
const TYPE_BY_PATH_HINT = [
  [/telephone/i, "phone"],
  [/email/i, "email"],
  [/postalCode/i, "postalCode"],
  [/(^|\.)image$|logo/i, "imageUrl"],
  [/openingHours/i, "openingHoursText"],
  [/url$|sameAs/i, "url"],
];

function inferType(jsonldPath) {
  for (const [re, type] of TYPE_BY_PATH_HINT) {
    if (re.test(jsonldPath)) return type;
  }
  return "text";
}

// Mechanical, attribute-anchored fields are safe to auto-apply; anything
// requiring a judgment call on free text is opt-in only (see README).
function inferAutoUpdate(type) {
  return type !== "text" && type !== "openingHoursText";
}

function inferId(jsonldPath) {
  return jsonldPath
    .replace(/\[(\d+)\]/g, "$1")
    .split(".")
    .pop();
}

// Flatten the schema.org object into {jsonldPath, value} leaves, skipping
// _meta (crawler bookkeeping, not part of the public document), @-keys,
// and anything the LLM couldn't find on the page (null).
function flattenSchemaFields(obj, prefix = "") {
  const leaves = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key === "_meta" || key.startsWith("@") || value == null) continue;
    const jsonldPath = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        const itemPath = `${jsonldPath}[${i}]`;
        if (item && typeof item === "object") {
          leaves.push(...flattenSchemaFields(item, itemPath));
        } else if (item != null) {
          leaves.push({ jsonldPath: itemPath, value: item });
        }
      });
    } else if (typeof value === "object") {
      leaves.push(...flattenSchemaFields(value, jsonldPath));
    } else {
      leaves.push({ jsonldPath, value });
    }
  }
  return leaves;
}

function extractCandidate($, selector, extract) {
  try {
    const el = $(selector).first();
    if (!el || el.length === 0) return null;
    if (extract === "text") {
      const t = el.text().trim();
      return t.length ? t : null;
    }
    if (extract && extract.startsWith("attr:")) {
      return el.attr(extract.split(":")[1]) || null;
    }
    return null;
  } catch (err) {
    return null; // malformed/hallucinated selector
  }
}

function normalizeForCompare(type, raw) {
  if (raw == null) return null;
  const str = String(raw).trim();
  if (type === "phone") return str.replace(/^tel:/, "").trim();
  if (type === "email") return str.replace(/^mailto:/, "").trim();
  return str;
}

/** Ask the local LLM (LM Studio) for candidate selectors for every field at once. */
async function proposeCandidatesWithLLM(fields, html) {
  const fieldsDescription = fields
    .map(
      (f) =>
        `- id: "${f.id}", jsonldPath: "${f.jsonldPath}", type: "${f.type}", expected value: ${JSON.stringify(f.value)}`,
    )
    .join("\n");

  const prompt = `You are building a CSS selector map for a web scraper.
Below is a list of fields already extracted into a schema.org JSON-LD document, each
with the value currently found on the page. For each field, propose up to 4 candidate
CSS selectors (best first) that would extract that exact value from the page HTML today.
Prefer attribute-based selectors (href, src, alt, data-hook) over class names, since
class names on this site are auto-generated and unstable.

Fields:
${fieldsDescription}

Page HTML:
---
${html.slice(0, 12000)}
---
Respond ONLY with JSON, no prose:
{"fields": [{"id": "...", "candidates": [{"selector": "...", "extract": "text|attr:href|attr:src"}]}]}`;

  const { text } = await generateText({
    model: lmstudio(process.env.MODEL_NAME || "local-model"),
    maxOutputTokens: 1500,
    prompt,
  });

  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return parsed.fields || [];
  } catch (err) {
    return [];
  }
}

async function generateSelectors({ schema, page }) {
  const $ = page;
  const html = page.html();

  const runTimestamp = new Date().toISOString();

  const leaves = flattenSchemaFields(schema).map((leaf) => ({
    id: inferId(leaf.jsonldPath),
    jsonldPath: leaf.jsonldPath,
    type: inferType(leaf.jsonldPath),
    value: leaf.value,
  }));

  const proposalsById = new Map(
    (await proposeCandidatesWithLLM(leaves, html)).map((f) => [
      f.id,
      f.candidates || [],
    ]),
  );

  const fields = [];
  for (const leaf of leaves) {
    const candidates = proposalsById.get(leaf.id) || [];
    const expected = normalizeForCompare(leaf.type, String(leaf.value));

    // Every candidate is tested against the live HTML — it must actually
    // resolve AND reproduce the value already trusted in schema.jsonld.
    // The LLM never gets to just assert a selector works.
    const verified = candidates
      .map((c) => ({
        ...c,
        normalized: normalizeForCompare(
          leaf.type,
          extractCandidate($, c.selector, c.extract),
        ),
      }))
      .filter((c) => c.normalized != null && c.normalized === expected);

    if (verified.length === 0) continue; // nothing validated — repair.js picks this up later

    // A field's selectors/fallbackSelectors share one extract mode (that's
    // what crawler.js applies to every selector in the list), so only keep
    // candidates that agree with the best match's extract mode.
    const extract = verified[0].extract;
    const usable = verified.filter((c) => c.extract === extract);

    fields.push({
      id: leaf.id,
      jsonldPath: leaf.jsonldPath,
      type: leaf.type,
      extract,
      autoUpdate: inferAutoUpdate(leaf.type),
      selectors: [usable[0].selector],
      fallbackSelectors: usable.slice(1).map((c) => c.selector),
      lastVerified: runTimestamp,
      lastRawValue: usable[0].normalized,
    });
  }

  return {
    sourceUrl: (schema._meta && schema._meta.sourceUrl) || null,
    fields,
  };
}

module.exports = { generateSelectors };
