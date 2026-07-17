/**
 * schema.js
 * --------------------------------------------------------------
 * Generates the initial schema.jsonld for a site the crawler hasn't
 * seen before, by asking a local LLM (via LM Studio's OpenAI-compatible
 * server) to read the page HTML and produce schema.org JSON-LD.
 * Runs once per site — after this, selector-map.json + the regular
 * crawl loop keep schema.jsonld in sync.
 * --------------------------------------------------------------
 */

const { generateText } = require("ai");
const { createOpenAICompatible } = require("@ai-sdk/openai-compatible");

const lmstudio = createOpenAICompatible({
  name: "lmstudio",
  baseURL: `${process.env.MODEL_PROVIDER_URL}/v1`,
});

async function generateSchema({ url, html }) {
  const prompt = `You are generating an initial schema.org JSON-LD document for a business website.
Source URL: ${url}
Here is the page HTML:
---
${(html || "").slice(0, 12000)}
---
Read the HTML and extract whatever of the following you can find: name, url, telephone,
email, address (streetAddress, postalCode, addressLocality, addressCountry), opening hours,
menu links (name + url), social profile links (sameAs), and a logo image URL.
Pick the most fitting schema.org @type (e.g. "Restaurant", "LocalBusiness") for this site.
Use null for anything you can't find — do not invent data.
Respond ONLY with a single, VALID JSON-LD object, no prose, no markdown fences.`;

  const { text } = await generateText({
    model: lmstudio(process.env.MODEL_NAME || "local-model"),
    prompt,
  });

  console.log({ text });

  const cleaned = text.replace(/```json|```/g, "").trim();

  const schema = JSON.parse(cleaned);

  schema._meta = {
    lastCrawled: null,
    sourceUrl: url,
    openingHoursRawText: null,
  };

  return schema;
}

module.exports = { generateSchema };
