const fs = require("fs/promises");
const path = require("path");
const cheerio = require("cheerio");
const { z } = require("zod");
const { buildSchema } = require("./schema-builder");

/**
 * The AI the extractor depends on. Inject any implementation, for example
 * `createAI()` from `lib/ai-sdk.js`.
 *
 * @typedef {object} AI
 * @property {(options: { prompt: string, schema: z.ZodTypeAny }) => Promise<any>} generateObject
 *   Returns an object that matches `schema`.
 * @property {(options: { prompt: string, options: Array<string> }) => Promise<string>} generateChoice
 *   Returns one of `options`.
 */

// Removes elements that never hold extractable content (scripts, styles,
// comments, svg internals, head). Both the LLM prompt and selector matching
// use the result, so positional selectors the AI proposes (`:first-child`,
// `:nth-of-type()`) point at the same elements when values are resolved.
function removeNonContent(html) {
  if (!html) return "";

  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const $ = cheerio.load(withoutComments);

  $("head, script, style, noscript, template, svg").remove();

  return $.html();
}

// Also strips noisy attributes (inline style, event handlers) and collapses
// whitespace before the HTML is embedded in a prompt. Cuts prompt size
// dramatically since it's resent on every extraction call at every nesting
// level. Attributes and whitespace don't affect which elements a selector
// matches, so this step is safe to skip for matching.
function pruneHtml(html) {
  const $ = cheerio.load(removeNonContent(html));

  $("*").each((_, el) => {
    if (!el.attribs) return;
    delete el.attribs.style;
    for (const attr of Object.keys(el.attribs)) {
      if (attr.startsWith("on")) delete el.attribs[attr];
    }
  });

  return $.html().replace(/\s+/g, " ").trim();
}

async function extractFields({ ai, fields, html, itemCount = 1 }) {
  const fieldList = fields
    .map(
      ({ name, description, example }) =>
        `- "${name}": ${description}${example ? ` (for example "${example}")` : ""}`,
    )
    .join("\n");

  const prompt = `You are extracting information from HTML for a web scraper.
Here is the page HTML:
\`\`\`html
${pruneHtml(html)}
\`\`\`
Extract these fields from the HTML:
${fieldList}

For each field, pick the most fitting value form the HTML. Use null for anything you can't find —
do not invent data. Then propose up to 1 candidate CSS selector that would select
that exact value in the HTML above. Prefer attribute-based selectors (href, src, alt, data-hook)
over class names, since class names on this site are auto-generated and unstable.${
    itemCount > 1
      ? `

The HTML holds ${itemCount} items of the same list, one after another. Each selector runs
inside every item on its own, so it must select the field in each of them. Don't build a
selector from values that belong to one item, such as its id, href, or text.`
      : ""
  }

Respond with only a JSON object, no other text, shaped exactly like this (one entry per field,
"candidates" holding up to 2 selector string):
{ ${fields.map(({ name }) => `"${name}": { "value": string | null, "candidates": string[] }`).join(", ")} }`;

  const schema = z.object(
    Object.fromEntries(
      fields.map(({ name, description }) => [
        name,
        z.object({
          value: z
            .string()
            .nullable()
            .describe(`value that is most fitting for "${description}"`),
          candidates: z
            .array(
              z.string().describe(`CSS selector for ${name}: ${description}`),
            )
            .max(2)
            .describe(`Array of CSS selectors for ${name}: ${description}`),
        }),
      ]),
    ),
  );

  try {
    return await ai.generateObject({ prompt, schema });
  } catch {
    return {};
  }
}

async function extractContainer({ ai, field, html }) {
  const itemFieldList = field.fields
    .map(({ name, description }) => `- "${name}": ${description}`)
    .join("\n");

  const prompt = `You are locating a repeating list of elements in HTML for a web scraper.
Here is the page HTML:
\`\`\`html
${pruneHtml(html)}
\`\`\`
Find the container element that repeats once per item for: "${field.name}" - ${field.description}

Each item has these fields:
${itemFieldList}

Every container must hold the values of these fields as text inside it. Values only get
extracted from inside the container, so a container that leaves a field out (for example,
a tab panel whose title only appears in a separate tab list) is wrong; pick the element that
does hold the values instead (for example, the tab itself).

Propose up to 2 candidate CSS selectors (best first) that would each select ALL of the
repeating container elements (one match per item), not the text inside them. Prefer
attribute-based selectors (data-hook, etc.) over class names, since class names on this site
are auto-generated and unstable.

Respond with only a JSON object, no other text, shaped exactly like this:
{ "candidates": string[] }`;

  const schema = z.object({
    candidates: z.array(z.string()).max(2),
  });

  try {
    const { candidates } = await ai.generateObject({ prompt, schema });
    return candidates;
  } catch {
    return [];
  }
}

async function generateClassifycation({ ai, classyfication, fields }) {
  const { type, description, options } = classyfication;

  const fieldSummary = fields
    .map(({ name, value }) => `- "${name}": ${JSON.stringify(value)}`)
    .join("\n");

  const optionList = options
    .map(({ title, definition }) => `- "${title}": ${definition}`)
    .join("\n");

  const prompt = `You are classifying a web page entity based on data extracted from it.
Classification: ${type}
${description}

Extracted fields:
${fieldSummary}

Choose exactly one of these options that best fits:
${optionList}

Answer with the title of exactly one option, written exactly as it appears in
quotes above, without the quotes or the definition.`;

  return ai.generateChoice({
    prompt,
    options: options.map(({ title }) => title),
  });
}

async function writeJson(dir, name, data) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${encodeURIComponent(name)}.json`),
    JSON.stringify(data, null, 2),
  );
}

function persistSchema(schema) {
  return writeJson("schemas", schema.id, schema);
}

function pageDir(page) {
  return path.join("pages", encodeURIComponent(page.url));
}

function persistPage(page) {
  return writeJson(pageDir(page), "page-schema", page);
}

function persistValues(page, values) {
  return writeJson(pageDir(page), "page-values", values);
}

// Copies a schema's field tree for one page, giving every field its own
// selector list (seeded from any predefined selectors) so each page learns
// its own selectors.
function createPageFields(schemaFields) {
  return schemaFields.map(({ fields, selectorCandidates = [], ...field }) => ({
    ...field,
    selectorCandidates: [...selectorCandidates],
    ...(fields ? { fields: createPageFields(fields) } : {}),
  }));
}

function addSelectorCandidates(field, candidates) {
  field.selectorCandidates = [
    ...new Set([...field.selectorCandidates, ...candidates]),
  ];
}

// Moves the selectors that find a value in the most containers to the front,
// so an item-specific selector the AI proposed doesn't shadow a general one.
function rankSelectorCandidates($, fields, containers) {
  const items = containers.map((container) => cheerio.load($.html(container)));

  for (const field of fields) {
    if (field.dataType === "object" || field.dataType === "array") continue;

    const coverage = new Map(
      field.selectorCandidates.map((selector) => [
        selector,
        items.filter(($item) => $item(selector).first().text().trim()).length,
      ]),
    );
    field.selectorCandidates.sort((a, b) => coverage.get(b) - coverage.get(a));
  }
}

async function assignSelectorCandidates(ai, fields, html, itemCount = 1) {
  const leafFields = fields.filter(
    (field) => field.dataType !== "object" && field.dataType !== "array",
  );

  if (leafFields.length) {
    const results = await extractFields({
      ai,
      fields: leafFields,
      html,
      itemCount,
    });

    for (const field of leafFields) {
      const { candidates = [] } = results[field.name] ?? {};
      addSelectorCandidates(field, candidates);
    }
  }

  for (const field of fields) {
    if (field.dataType === "object" && field.fields?.length) {
      await assignSelectorCandidates(ai, field.fields, html, itemCount);
    }

    if (field.dataType === "array" && field.fields?.length) {
      addSelectorCandidates(field, await extractContainer({ ai, field, html }));

      const $ = cheerio.load(html);
      const containerSelector = field.selectorCandidates.find(
        (selector) => $(selector).length,
      );
      const containers = containerSelector
        ? $(containerSelector).toArray()
        : [];

      // Shows the AI a few items so it proposes selectors that work for all
      // of them, not only the first.
      const samples = containers.slice(0, 3);
      const itemHtml = samples.length
        ? samples.map((container) => $.html(container)).join("\n")
        : html;

      await assignSelectorCandidates(
        ai,
        field.fields,
        itemHtml,
        samples.length || 1,
      );
      rankSelectorCandidates($, field.fields, containers);
    }
  }
}

async function resolveFields(ai, $, fields, classifications = []) {
  const values = {};

  for (const field of fields) {
    if (field.dataType === "object" && field.fields?.length) {
      values[field.name] = {
        type: field.entityType,
        ...(await resolveFields(ai, $, field.fields, field.classifications)),
      };
      continue;
    }

    if (field.dataType === "array" && field.fields?.length) {
      const containerSelector = field.selectorCandidates.find(
        (selector) => $(selector).length,
      );
      const containers = containerSelector
        ? $(containerSelector).toArray()
        : [];

      values[field.name] = [];
      for (const container of containers) {
        const $item = cheerio.load($.html(container));
        values[field.name].push({
          type: field.entityType,
          ...(await resolveFields(
            ai,
            $item,
            field.fields,
            field.classifications,
          )),
        });
      }
      continue;
    }

    let value = null;
    for (const selector of field.selectorCandidates) {
      const el = $(selector).first();
      const text = el.text().replace(/\s+/g, " ").trim();
      if (el.length && text) {
        value = text;
        break;
      }
    }
    values[field.name] = value;
  }

  for (const classyfication of classifications) {
    const fieldValues = fields.map(({ name }) => ({
      name,
      value: values[name],
    }));
    values[classyfication.type] = await generateClassifycation({
      ai,
      classyfication,
      fields: fieldValues,
    });
  }

  return values;
}

class CrawlerClient {
  #browser;
  #ai;
  /** @type {Map<string, string>} `extract()` name by schema ID. */
  #schemaNames = new Map();
  /** @type {Map<string, string>} HTML passed to `extract()` by page URL. */
  #htmlByUrl = new Map();
  /**
   * @param {import("./browser")} browser The client takes ownership and
   *   closes it when `run()` finishes.
   * @param {AI} ai Proposes selectors and classifies entities.
   */
  constructor(browser, ai) {
    this.#browser = browser;
    this.#ai = ai;
    /** @type {Record<string, object>} Schemas by ID. */
    this.schemas = {};
    /** @type {Record<string, { url: string, name: string, schemaId: string, fields: Array<object> }>} Pages by URL. */
    this.pages = {};
    /** Defines reusable schemas outside of `extract()`. */
    this.schema = {
      createSchema: (options) => this.#createSchema(options),
    };
  }

  /**
   * Creates a standalone schema you can reuse as the nested schema of an
   * `object` or `array` field: `(builder) => ({ schema })`.
   *
   * @param {object} options
   * @param {string} options.name
   * @param {string} [options.id] Schema ID. Defaults to `name`.
   * @param {string} [options.entity] Entity type of the extracted values.
   * @param {Array<object>} [options.classifications]
   * @param {Array<{ name: string, description: string, fieldType?: string, dataType: string, example?: string, fields?: Array<object> }>} options.fields
   *   `example` shows the AI what a value looks like.
   * @returns {Promise<object>} The schema.
   */
  async #createSchema({
    name,
    id = name,
    entity = null,
    classifications = [],
    fields,
  }) {
    const schema = {
      id,
      name,
      entityType: entity,
      classifications: structuredClone(classifications),
      fields: structuredClone(fields),
    };

    this.schemas[schema.id] = schema;
    return schema;
  }

  /**
   * Builds a schema and adds one page per URL. Each page gets its own copy
   * of the schema's fields, so selectors learned on one website don't leak
   * into another. A URL added again replaces its earlier page.
   *
   * @param {object} options
   * @param {string} [options.id] Schema ID. Defaults to `name`.
   * @param {string} options.name
   * @param {Array<string>} options.urls Pages to extract with this schema.
   * @param {string} [options.html] HTML to extract from instead of loading
   *   each URL in the browser. The URLs then only identify the pages.
   * @param {(builder: import("./schema-builder").SchemaBuilder) => import("./schema-builder").SchemaBuilder | { schema: object } | void} options.extraction
   *   Either builds the schema with `builder`, or returns `{ schema }` with a
   *   predefined schema. A predefined schema's `id`, `entityType`,
   *   `classifications`, and `fields` override the defaults.
   * @returns {this}
   */
  extract(options) {
    const { id = options.name, urls, name, html, extraction } = options;

    const builtSchema = {
      id,
      name,
      entityType: null,
      classifications: [],
      fields: [],
    };

    const schema = buildSchema(builtSchema, extraction);

    this.schemas[schema.id] = schema;
    this.#schemaNames.set(schema.id, name);

    for (const url of urls) {
      this.pages[url] = {
        url,
        name,
        schemaId: schema.id,
        fields: createPageFields(schema.fields),
      };

      if (html === undefined) this.#htmlByUrl.delete(url);
      else this.#htmlByUrl.set(url, html);
    }

    return this;
  }

  /**
   * Generates selector candidates for every page from that page's own HTML.
   * Schemas and pages stay in memory; save them with `persistSchema()` and
   * `persistPage()`. Call before `run()`. Closes the browser on failure.
   *
   * @returns {Promise<this>}
   */
  async create() {
    try {
      for (const page of Object.values(this.pages)) {
        const html = await this.#loadHTML(page.url);
        await assignSelectorCandidates(this.#ai, page.fields, html);
      }
    } catch (error) {
      await this.#browser.close();
      throw error;
    }
    return this;
  }

  /**
   * Returns every page, one per URL, in insertion order.
   *
   * @returns {Promise<Array<{ url: string, name: string, schemaId: string, fields: Array<object> }>>}
   */
  async getPages() {
    return Object.values(this.pages);
  }

  /**
   * Finds every page added by the `extract()` call with this `name`, one per
   * URL, in insertion order.
   *
   * @param {object} options
   * @param {string} options.name
   * @returns {Promise<Array<{ url: string, name: string, schemaId: string, fields: Array<object> }>>}
   *   An empty array when no page has this name.
   */
  async getPage({ name }) {
    return (await this.getPages()).filter(
      ({ name: pageName }) => pageName === name,
    );
  }

  /**
   * Returns every schema, in insertion order.
   *
   * @returns {Promise<Array<object>>}
   */
  async getSchemas() {
    return Object.values(this.schemas);
  }

  /**
   * Finds every schema added by an `extract()` call with this `name`, in
   * insertion order. Matches the `extract()` name, not the schema's own
   * `name`, which a predefined schema can override.
   *
   * @param {object} options
   * @param {string} options.name
   * @returns {Promise<Array<object>>} An empty array when no schema has this
   *   name.
   */
  async getSchema({ name }) {
    return (await this.getSchemas()).filter(
      ({ id }) => this.#schemaNames.get(id) === name,
    );
  }

  /**
   * Extracts values from every page, one after another, then closes the
   * browser.
   *
   * @returns {Promise<Array<{ id: string, url: string, values: object }>>}
   *   One entry per page, in insertion order.
   */
  async run() {
    try {
      const results = [];
      for (const page of Object.values(this.pages)) {
        const values = await this.#extractPage(page);
        results.push({ id: page.schemaId, url: page.url, values });
      }
      return results;
    } finally {
      await this.#browser.close();
    }
  }

  // Returns the page HTML without non-content elements, the same HTML the AI
  // sees, so its selectors match the elements it meant.
  async #loadHTML(url) {
    if (this.#htmlByUrl.has(url)) {
      return removeNonContent(this.#htmlByUrl.get(url));
    }

    const tab = await this.#browser.goto(url);
    try {
      return removeNonContent(await tab.html());
    } finally {
      await tab.close();
    }
  }

  async #extractPage(page) {
    const { entityType, classifications } = this.schemas[page.schemaId];
    const html = await this.#loadHTML(page.url);
    const $ = cheerio.load(html);

    const values = {
      type: entityType,
      ...(await resolveFields(this.#ai, $, page.fields, classifications)),
    };

    await persistValues(page, values);
    return values;
  }
}

/**
 * @param {import("./browser")} browser
 * @param {AI} ai
 */
function createClient(browser, ai) {
  return new CrawlerClient(browser, ai);
}

module.exports = { createClient, persistPage, persistSchema };
