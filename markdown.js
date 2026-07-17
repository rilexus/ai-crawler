/**
 * markdown.js
 * --------------------------------------------------------------
 * Converts raw page HTML to Markdown by asking a local LLM (via
 * LM Studio's OpenAI-compatible server) to read the HTML and produce
 * a clean Markdown rendering of its content. Same provider setup as
 * schema.js/selectors.js/repair.js.
 * --------------------------------------------------------------
 */

const { generateText } = require("ai");
const { createOpenAICompatible } = require("@ai-sdk/openai-compatible");

const lmstudio = createOpenAICompatible({
  name: "lmstudio",
  baseURL: `${process.env.MODEL_PROVIDER_URL}/v1`,
});

async function generateMarkdown({ html }) {
  const prompt = `Convert the following HTML page to clean Markdown.
Keep headings, lists, links, and tables; drop navigation chrome, scripts,
styles, and any other non-content boilerplate.
Here is the page HTML:
---
${(html || "").slice(0, 12000)}
---
Respond ONLY with the Markdown content, no prose, no code fences.`;

  const { text } = await generateText({
    model: lmstudio(process.env.MODEL_NAME || "local-model"),
    prompt,
  });

  return text.trim();
}

module.exports = { generateMarkdown };
