const { generateText, Output } = require("ai");

/**
 * Wraps an AI SDK language model in the `AI` interface the extractor
 * depends on.
 *
 * @param {import("ai").LanguageModel} model Any AI SDK language model that
 *   supports structured outputs.
 * @returns {import("../extractor").AI}
 */
function createAI(model) {
  return {
    async generateObject({ prompt, schema }) {
      const { output } = await generateText({
        model,
        prompt,
        output: Output.object({ schema }),
      });
      return output;
    },

    async generateChoice({ prompt, options }) {
      const { output } = await generateText({
        model,
        prompt,
        output: Output.choice({ options }),
      });
      return output;
    },
  };
}

module.exports = { createAI };
