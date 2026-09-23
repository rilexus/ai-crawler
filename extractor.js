const fs = require("fs/promises");
const path = require("path");
const { generateText, Output } = require("ai");
// const { loadPageFromUrl } = require("./browser");
const { createOpenAICompatible } = require("@ai-sdk/openai-compatible");
const cheerio = require("cheerio");
const { z } = require("zod");

const apiKey = process.env.DEEP_SEEK_API_KEY;
const baseURL = `${process.env.DEEP_SEEK_API_URL}`;

const deepseek = createOpenAICompatible({
  name: "deepseek",
  baseURL,
  apiKey,
});

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

async function extractFields({ fields, html }) {
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
    const { output } = await generateText({
      model: deepseek(process.env.DEEP_SEEK_MODEL_NAME || "deepseek-chat"),
      prompt,
      output: Output.object({ schema }),
    });
    return output;
  } catch {
    return {};
  }
}

async function extractContainer({ field, html }) {
  const prompt = `You are locating a repeating list of elements in HTML for a web scraper.
Here is the page HTML:
\`\`\`html
${pruneHtml(html)}
\`\`\`
Find the container element that repeats once per item for: "${field.name}" - ${field.description}

Propose up to 4 candidate CSS selectors (best first) that would each select ALL of the
repeating container elements (one match per item), not the text inside them. Prefer
attribute-based selectors (data-hook, etc.) over class names, since class names on this site
are auto-generated and unstable.

Respond with only a JSON object, no other text, shaped exactly like this:
{ "candidates": string[] }`;

  const schema = z.object({
    candidates: z.array(z.string()).max(4),
  });

  try {
    const { output } = await generateText({
      model: deepseek(process.env.DEEP_SEEK_MODEL_NAME || "deepseek-chat"),
      prompt,
      output: Output.object({ schema }),
    });
    return output.candidates;
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

Respond with a JSON object matching the requested schema.`;

  const { output } = await generateText({
    model: deepseek(process.env.DEEP_SEEK_MODEL_NAME || "deepseek-chat"),
    prompt,
    output: Output.choice({ options: options.map(({ title }) => title) }),
  });

  return output;
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
      const containers = containerSelector
        ? $(containerSelector).toArray()
        : [];

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
