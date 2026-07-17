const fs = require("fs/promises");
const path = require("path");
const { generateText } = require("ai");
const { loadPageFromUrl } = require("./browser");
const { createOpenAICompatible } = require("@ai-sdk/openai-compatible");
const cheerio = require("cheerio");

const lmstudio = createOpenAICompatible({
  name: "lmstudio",
  baseURL: `${process.env.MODEL_PROVIDER_URL}/v1`,
});

async function extractFields({ fields, html }) {
  const fieldList = fields
    .map(({ name, description }) => `- "${name}": ${description}`)
    .join("\n");

  const prompt = `You are extracting information from HTML for a web scraper.
Here is the page HTML:
\`\`\`html
${html || ""}
\`\`\`
Extract these fields from the HTML:
${fieldList}

For each field, pick the most fitting value for the HTML. Use null for anything you can't find —
do not invent data. Then propose up to 4 candidate CSS selectors (best first) that would select
that exact value in the HTML above. Prefer attribute-based selectors (href, src, alt, data-hook)
over class names, since class names on this site are auto-generated and unstable.

Respond ONLY with JSON, no prose, keyed by field name:
{"<fieldName>": {"value": "...", "candidates": ["<selector>"]}}`;

  const { text } = await generateText({
    model: lmstudio(process.env.MODEL_NAME || "local-model"),
    prompt,
  });

  const json = text
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "");

  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

async function extractContainer({ field, html }) {
  const prompt = `You are locating a repeating list of elements in HTML for a web scraper.
Here is the page HTML:
\`\`\`html
${html || ""}
\`\`\`
Find the container element that repeats once per item for: "${field.name}" - ${field.description}

Propose up to 4 candidate CSS selectors (best first) that would each select ALL of the
repeating container elements (one match per item), not the text inside them. Prefer
attribute-based selectors (data-hook, etc.) over class names, since class names on this site
are auto-generated and unstable.

Respond ONLY with JSON, no prose:
{"candidates": ["<selector>"]}`;

  const { text } = await generateText({
    model: lmstudio(process.env.MODEL_NAME || "local-model"),
    prompt,
  });

  const json = text
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "");

  try {
    const { candidates = [] } = JSON.parse(json);
    return candidates;
  } catch {
    return [];
  }
}

async function generateClassifycation({ classyfication, fields }) {
  const { type, description, options } = classyfication;

  const fieldSummary = fields
    .map(({ name, value }) => `- "${name}": ${JSON.stringify(value)}`)
    .join("\n");

  const optionList = options
    .map(({ title, definition }) => `- "${title}: ${definition}"`)
    .join("\n");

  const prompt = `You are classifying a web page entity based on data extracted from it.
Classification: ${type}
${description}

Extracted fields:
${fieldSummary}

Choose exactly one of these options that best fits:
${optionList}

Respond ONLY with the chosen option's exact text, no prose, no quotes.`;

  const { text } = await generateText({
    model: lmstudio(process.env.MODEL_NAME || "local-model"),
    prompt,
  });

  const value = text.trim();
  return value;
}

async function persistSchema(schema) {
  const dir = path.join("schemas", encodeURIComponent(schema.url));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${encodeURIComponent(schema.name)}-schema.json`),
    JSON.stringify(schema, null, 2),
  );
}

async function persistValues(schema, values) {
  const dir = path.join("schemas", encodeURIComponent(schema.url));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${encodeURIComponent(schema.name)}-values.json`),
    JSON.stringify(values, null, 2),
  );
}

async function assignSelectorCandidates(fields, html) {
  const leafFields = fields.filter(
    (field) => field.dataType !== "object" && field.dataType !== "array",
  );

  if (leafFields.length) {
    const results = await extractFields({ fields: leafFields, html });

    for (const field of leafFields) {
      const { candidates: selectorCandidates = [] } = results[field.name] ?? {};
      field.selectorCandidates = selectorCandidates;
    }
  }

  for (const field of fields) {
    if (field.dataType === "object" && field.fields?.length) {
      await assignSelectorCandidates(field.fields, html);
    }

    if (field.dataType === "array" && field.fields?.length) {
      field.selectorCandidates = await extractContainer({ field, html });

      const $ = cheerio.load(html);
      const containerSelector = field.selectorCandidates.find(
        (selector) => $(selector).length,
      );
      const itemHtml = containerSelector
        ? $.html($(containerSelector).first())
        : html;

      await assignSelectorCandidates(field.fields, itemHtml);
    }
  }
}

async function resolveFields($, fields, classifications = []) {
  const values = {};

  for (const field of fields) {
    if (field.dataType === "object" && field.fields?.length) {
      values[field.name] = {
        type: field.entityType,
        ...(await resolveFields($, field.fields, field.classifications)),
      };
      continue;
    }

    if (field.dataType === "array" && field.fields?.length) {
      const containerSelector = field.selectorCandidates.find(
        (selector) => $(selector).length,
      );
      const containers = containerSelector ? $(containerSelector).toArray() : [];

      values[field.name] = [];
      for (const container of containers) {
        const $item = cheerio.load($.html(container));
        values[field.name].push({
          type: field.entityType,
          ...(await resolveFields($item, field.fields, field.classifications)),
        });
      }
      continue;
    }

    let value = null;
    for (const selector of field.selectorCandidates) {
      const el = $(selector).first();
      const text = el.text().trim();
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
      classyfication,
      fields: fieldValues,
    });
  }

  return values;
}

class SchemaBuilder {
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
      selectorCandidates: [],
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
  constructor() {
    this.schemas = [];
  }

  extract(options) {
    const { url, name, extraction } = options;
    this.url = url;

    const schema = {
      name,
      url,
      entityType: null,
      classifications: [],
      fields: [],
    };

    extraction(new SchemaBuilder(schema));
    this.schemas.push(schema);
    return this;
  }

  async create() {
    for (const schema of this.schemas) {
      const { fields, url } = schema;
      // const { html } = await loadPageFromUrl(url);
      const html = await fs.readFile(
        path.join(__dirname, "fixtures", "restaurant-snapshot-v1.html"),
        "utf8",
      );

      await assignSelectorCandidates(fields, html);
    }
    return this;
  }

  async run() {
    for (const schema of this.schemas) {
      const { url, fields, name } = schema;
      // const { html } = await loadPageFromUrl(url);
      const html = await fs.readFile(
        path.join(__dirname, "fixtures", "restaurant-snapshot-v1.html"),
        "utf8",
      );

      const $ = cheerio.load(html);

      const values = {
        type: schema.entityType,
        ...(await resolveFields($, fields, schema.classifications)),
      };

      await persistValues(schema, values);
      await persistSchema(schema);
    }
  }
}

function createClient() {
  return new CrawlerClient();
}

module.exports = { createClient };
