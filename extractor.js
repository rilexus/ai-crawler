const fs = require("fs/promises");
const path = require("path");
const cheerio = require("cheerio");
const { z } = require("zod");

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

// Strips markup that never helps selector/value extraction (scripts, styles,
// comments, svg internals, head) and unstable/noisy attributes (class, style,
// event handlers) before the HTML is embedded in a prompt. Cuts prompt size
// dramatically since it's resent on every extraction call at every nesting
// level. Only used for the LLM prompt — real selector matching against the
// page still runs against the original, unpruned HTML.
function pruneHtml(html) {
  if (!html) return "";

  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const $ = cheerio.load(withoutComments);

  $("head, script, style, noscript, template, svg").remove();

  $("*").each((_, el) => {
    if (!el.attribs) return;
    delete el.attribs.style;
    for (const attr of Object.keys(el.attribs)) {
      if (attr.startsWith("on")) delete el.attribs[attr];
    }
  });

  return $.html().replace(/\s+/g, " ").trim();
}

async function extractFields({ ai, fields, html }) {
  const fieldList = fields
    .map(({ name, description }) => `- "${name}": ${description}`)
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
over class names, since class names on this site are auto-generated and unstable.

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
  const prompt = `You are locating a repeating list of elements in HTML for a web scraper.
Here is the page HTML:
\`\`\`html
${pruneHtml(html)}
\`\`\`
Find the container element that repeats once per item for: "${field.name}" - ${field.description}

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

async function assignSelectorCandidates(ai, fields, html) {
  const leafFields = fields.filter(
    (field) => field.dataType !== "object" && field.dataType !== "array",
  );

  if (leafFields.length) {
    const results = await extractFields({ ai, fields: leafFields, html });

    for (const field of leafFields) {
      const { candidates = [] } = results[field.name] ?? {};
      addSelectorCandidates(field, candidates);
    }
  }

  for (const field of fields) {
    if (field.dataType === "object" && field.fields?.length) {
      await assignSelectorCandidates(ai, field.fields, html);
    }

    if (field.dataType === "array" && field.fields?.length) {
      addSelectorCandidates(field, await extractContainer({ ai, field, html }));

      const $ = cheerio.load(html);
      const containerSelector = field.selectorCandidates.find(
        (selector) => $(selector).length,
      );
      const itemHtml = containerSelector
        ? $.html($(containerSelector).first())
        : html;

      await assignSelectorCandidates(ai, field.fields, itemHtml);
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

class SchemaBuilder {
  id = null;

  constructor(schema) {
    this.schema = schema;
  }

  entity(type) {
    this.schema.entityType = type;
    return this;
  }

  field(name, description, type, extraction) {
    const field = {
      name,
      ...(typeof extraction === "function" ? { entityType: null } : {}),
      description,
      dataType: type,
    };

    if (typeof extraction === "function") {
      const nested = { entityType: null, classifications: [], fields: [] };
      extraction(new SchemaBuilder(nested));
      field.entityType = nested.entityType;
      field.classifications = nested.classifications;
      field.fields = nested.fields;
    }

    this.schema.fields.push(field);
    return this;
  }

  classify(type, description, options) {
    this.schema.classifications.push({
      type,
      description,
      options,
    });
    return this;
  }
}

class CrawlerClient {
  #browser;
  #ai;
  /** @type {Map<string, string>} `extract()` name by schema ID. */
  #schemaNames = new Map();
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
   * @param {(builder: SchemaBuilder) => SchemaBuilder | { schema: object } | void} options.extraction
   *   Either builds the schema with `builder`, or returns `{ schema }` with a
   *   predefined schema. A predefined schema's `id`, `entityType`,
   *   `classifications`, and `fields` override the defaults.
   * @returns {this}
   */
  extract(options) {
    const { id = options.name, urls, name, extraction } = options;

    const builtSchema = {
      id,
      name,
      entityType: null,
      classifications: [],
      fields: [],
    };

    // A builder chain returns the builder, whose `schema` is `builtSchema`.
    // A predefined schema replaces it, falling back to the defaults above for
    // anything it leaves out.
    const { schema: predefinedSchema } =
      extraction(new SchemaBuilder(builtSchema)) ?? {};
    const schema =
      predefinedSchema && predefinedSchema !== builtSchema
        ? { ...builtSchema, ...predefinedSchema }
        : builtSchema;

    this.schemas[schema.id] = schema;
    this.#schemaNames.set(schema.id, name);

    for (const url of urls) {
      this.pages[url] = {
        url,
        name,
        schemaId: schema.id,
        fields: createPageFields(schema.fields),
      };
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

  async #loadHTML(url) {
    const tab = await this.#browser.goto(url);
    try {
      return await tab.html();
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
