const { AsyncLocalStorage } = require("node:async_hooks");
const { tool } = require("ai");

// The chain of flows and steps running in the current async context, such as
// ["reddit_create_post", "reddit_open_post_editor", "click Create"].
const trail = new AsyncLocalStorage();

/**
 * An error from inside a flow. The message starts with the chain of flows and
 * steps that led to it, and `cause` holds the original error.
 */
class FlowError extends Error {
  /**
   * @param {string[]} path The flows and steps that were running.
   * @param {unknown} cause The original error.
   */
  constructor(path, cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`${path.join(" > ")}: ${message}`, { cause });
    this.name = "FlowError";
    this.path = path;
  }
}

/**
 * Wraps `error` in a `FlowError` for `path`. An error that's already a
 * `FlowError` came from deeper in the chain and carries the longer path, so
 * it passes through unchanged.
 *
 * @param {string[]} path
 * @param {unknown} error
 * @returns {FlowError}
 */
function wrap(path, error) {
  return error instanceof FlowError ? error : new FlowError(path, error);
}

/**
 * Runs `fn` as a named step of the current flow. The step shows up in the log
 * and in the path of any error thrown inside it. Steps can contain other steps
 * and other flows.
 *
 * @template T
 * @param {string} label What the step does, such as "enter the title".
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function step(label, fn) {
  const path = [...(trail.getStore() ?? []), label];
  return trail.run(path, async () => {
    log(path);
    try {
      return await fn();
    } catch (error) {
      throw wrap(path, error);
    }
  });
}

/**
 * Formats a Zod error on one line, such as
 * `title: String must contain at least 1 character(s)`.
 *
 * @param {import("zod").ZodError} error
 * @returns {string}
 */
function describeIssues(error) {
  return error.issues
    .map((issue) =>
      issue.path.length
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
}

/**
 * Prints `path`'s last entry, indented by how deeply it's nested.
 *
 * @param {string[]} path
 */
function log(path) {
  console.log(`${"  ".repeat(path.length - 1)}${path.at(-1)}`);
}

/**
 * Defines a reusable sequence of page interactions.
 *
 * @template {import("zod").ZodTypeAny} I
 * @template O
 * @param {object} definition
 * @param {string} definition.name A unique name made of letters, digits, and
 *   underscores, such as `reddit_create_post`. Model providers reject tool
 *   names with other characters.
 * @param {string} definition.description What the flow does and which page it
 *   can start from. A model reads this when it chooses a flow.
 * @param {I} [definition.input] Validates and fills in defaults for the input.
 * @param {import("zod").ZodType<O>} [definition.output] Validates the result.
 * @param {(page: import("./page"), input: import("zod").infer<I>, context: { step: typeof step }) => Promise<O>} definition.run
 * @returns {((page: import("./page"), input?: import("zod").input<I>) => Promise<O>) & { definition: object }}
 *   An async function that runs the flow. Call it like any other function,
 *   including from inside another flow.
 * @throws {FlowError} From the returned function, for invalid input or
 *   output, or for any error while the flow runs.
 */
function defineFlow({ name, description, input, output, run }) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new Error(
      `Invalid flow name "${name}". Use up to 64 letters, digits, underscores, or hyphens.`,
    );
  }

  async function flow(page, rawInput = {}) {
    const path = [...(trail.getStore() ?? []), name];

    return trail.run(path, async () => {
      log(path);

      const parsedInput = input ? input.safeParse(rawInput) : null;
      if (parsedInput && !parsedInput.success) {
        throw new FlowError(
          path,
          `Invalid input: ${describeIssues(parsedInput.error)}`,
        );
      }

      let result;
      try {
        result = await run(page, parsedInput ? parsedInput.data : rawInput, {
          step,
        });
      } catch (error) {
        throw wrap(path, error);
      }

      const parsedOutput = output ? output.safeParse(result) : null;
      if (parsedOutput && !parsedOutput.success) {
        throw new FlowError(
          path,
          `Invalid output: ${describeIssues(parsedOutput.error)}`,
        );
      }
      return parsedOutput ? parsedOutput.data : result;
    });
  }

  flow.definition = { name, description, input, output };
  return flow;
}

/**
 * Turns flows into AI SDK tools that run on `page`, for `generateText` or
 * `streamText`. A flow without an `input` schema takes no arguments.
 *
 * @param {import("./page")} page
 * @param {Array<ReturnType<typeof defineFlow>>} flows
 * @returns {Record<string, import("ai").Tool>}
 */
function toTools(page, flows) {
  const { z } = require("zod");
  return Object.fromEntries(
    flows.map((flow) => {
      const { name, description, input } = flow.definition;
      return [
        name,
        tool({
          description,
          inputSchema: input ?? z.object({}),
          execute: (args) => flow(page, args),
        }),
      ];
    }),
  );
}

module.exports = { defineFlow, step, toTools, FlowError };
