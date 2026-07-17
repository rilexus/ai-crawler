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

class SchemaBuilder {
  constructor(schema) {
    this.schema = schema;
  }

  entity(type) {
    this.schema.entityType = type;
    return this;
  }

  field(name, description, type) {
    this.schema.fields.push({
      name,
      description,
      dataType: type,
      selectorCandidates: [],
      value: null,
    });
    return this;
  }

  classify(type, description, options) {
    this.schema.classifications.push({
      type,
      description,
      options,
      value: null,
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

      const results = await extractFields({ fields, html });

      for (const field of fields) {
        const { value = null, candidates: selectorCandidates = [] } =
          results[field.name] ?? {};

        field.selectorCandidates = selectorCandidates;
      }
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

      for (const field of fields) {
        const { selectorCandidates } = field;
        let value = null;

        for (const selector of selectorCandidates) {
          const el = $(selector).first();
          if (el.length) {
            value = el.text().trim();
            break;
          }
        }

        field.value = value;
      }

      for (const classyfication of schema.classifications) {
        const { fields } = schema;
        classyfication.value = await generateClassifycation({
          classyfication,
          fields,
        });
      }

      await persistSchema(schema);
    }
  }
}

function createClient() {
  return new CrawlerClient();
}

module.exports = { createClient };
