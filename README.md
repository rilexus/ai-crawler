# ai-crawler

LLM-assisted web extraction. You describe the entities and fields you want
from a set of pages, and an LLM proposes CSS selectors for each field. Every
value comes from running a selector against the page HTML with `cheerio`, so
the LLM never supplies a value directly.

The extractor doesn't depend on a specific LLM provider. You inject an `AI`
object, and `lib/ai-sdk.js` provides one for any
[AI SDK](https://ai-sdk.dev) language model. `index.js` uses DeepSeek through
an OpenAI-compatible endpoint.

## Set up

1. Install dependencies:

   ```bash
   npm install
   ```

2. Add the DeepSeek settings to `.env`:

   ```dotenv
   DEEP_SEEK_API_URL=<OpenAI-compatible base URL>
   DEEP_SEEK_API_KEY=<API key>
   DEEP_SEEK_MODEL_NAME=deepseek-chat   # Optional. Defaults to deepseek-chat.
   ```

3. Run the example workflow in `index.js`:

   ```bash
   npm run dev
   ```

## Usage

```js
const { createClient, persistPage, persistSchema } = require("./extractor");
const { createAI } = require("./lib/ai-sdk");
const Browser = require("./browser");

const client = createClient(new Browser(), createAI(model));

const workflow = await client
  .extract({
    name: "restaurants",
    urls: ["https://example.com/restaurant/1", "https://example.com/restaurant/2"],
    extraction: (builder) =>
      builder
        .entity("Restaurant")
        .field("name", "The name of the restaurant.", "string"),
  })
  .create();

for (const schema of await workflow.getSchemas()) {
  await persistSchema(schema);
}

await workflow.run();

for (const page of await workflow.getPages()) {
  await persistPage(page);
}
```

### Create a client

`createClient(browser, ai)` takes two dependencies:

- `browser`: loads page HTML with `loadHTML(url)` and shuts down with
  `close()`. `browser/index.js` provides a headless Chromium implementation.
  The client takes ownership of the browser and closes it when `run()`
  finishes, or when `create()` fails.
- `ai`: proposes selectors and classifies entities. It must implement the
  `AI` interface described in [The `ai` dependency](#the-ai-dependency).

#### The `ai` dependency

The extractor doesn't call an LLM provider itself. It calls the two async
methods on the `ai` object you pass to `createClient`. The `AI` typedef at the
top of `extractor.js` defines them.

| Method | Receives | Must resolve to |
| --- | --- | --- |
| `generateObject({ prompt, schema })` | `prompt`: the full prompt, as a string. `schema`: a Zod object schema that describes the expected output. | A plain object that matches `schema`. |
| `generateChoice({ prompt, options })` | `prompt`: the full prompt, as a string. `options`: the allowed answers, as an array of strings. | One string from `options`, exactly as given. |

The extractor uses each method like this:

- `create()` calls `generateObject` to propose selectors. For leaf fields,
  the schema has one key per field name, each shaped as
  `{ value: string | null, candidates: string[] }`. For array containers, the
  schema is `{ candidates: string[] }`.
- `run()` calls `generateChoice` once per classification on each entity, and
  stores the returned string as the classification value.

Your implementation is responsible for these guarantees:

- **Validate the output.** The extractor doesn't check what you return. Call
  `schema.parse()` on your result, or use a provider feature that enforces the
  schema. If a container result has no `candidates` array, `create()` fails.
- **Return an exact option.** `generateChoice` must return a string from
  `options`, not a paraphrase or a JSON wrapper.
- **Throw on failure.** If `generateObject` throws, the extractor treats that
  call as finding no selectors and continues. If `generateChoice` throws,
  `run()` fails and closes the browser.

##### Use an AI SDK model

`createAI(model)` from `lib/ai-sdk.js` builds the `ai` object from an AI SDK
language model and meets all three guarantees, because the AI SDK validates
structured outputs and choices. The `model` must be:

- A language model instance from an AI SDK provider package, such as
  `@ai-sdk/openai-compatible`. Pass the model, not the provider.
- A model that supports structured outputs. `createAI` requests JSON output
  for both methods.

This is how `index.js` builds it for DeepSeek:

```js
const { createOpenAICompatible } = require("@ai-sdk/openai-compatible");
const { createAI } = require("./lib/ai-sdk");

const deepseek = createOpenAICompatible({
  name: "deepseek",
  baseURL: process.env.DEEP_SEEK_API_URL,
  apiKey: process.env.DEEP_SEEK_API_KEY,
});

const client = createClient(
  new Browser(),
  createAI(deepseek(process.env.DEEP_SEEK_MODEL_NAME || "deepseek-chat")),
);
```

##### Write your own

If you don't use the AI SDK, any object with the two methods works. The
prompts don't assume a provider:

- The selector prompts spell out the exact JSON shape, so a JSON-mode LLM call
  and `schema.parse()` are enough for `generateObject`.
- The classification prompt asks for the title of one option as plain text,
  so `generateChoice` only has to check the reply against `options`.

```js
const ai = {
  async generateObject({ prompt, schema }) {
    const text = await callMyLLM(prompt, { json: true });
    return schema.parse(JSON.parse(text));
  },

  async generateChoice({ prompt, options }) {
    const answer = (await callMyLLM(prompt)).trim();
    if (!options.includes(answer)) {
      throw new Error(`Unexpected choice: ${answer}`);
    }
    return answer;
  },
};

const client = createClient(new Browser(), ai);
```

### Declare what to extract

Each `extract()` call adds one schema and one page per URL. Every page gets
its own copy of the schema's fields, so selectors learned on one site don't
leak into another.

| Option | Description |
| --- | --- |
| `name` | Name you use to look up the schema and its pages later. |
| `id` | Optional. Schema ID. Defaults to `name`. |
| `urls` | Pages to extract with this schema. Adding a URL again replaces its earlier page. |
| `extraction` | Builds the schema with the builder, or returns a predefined schema. |

To build the schema, chain builder methods:

- `.entity(type)` sets the entity type, for example `Restaurant`.
- `.field(name, description, "string")` adds a leaf value.
- `.field(name, description, "object", (builder) => ...)` adds one nested
  entity, for example a review's author.
- `.field(name, description, "array", (builder) => ...)` adds a repeating
  list, for example reviews. The LLM proposes a container selector that
  matches every item, and the nested fields resolve once per item.
- `.classify(type, description, options)` asks the LLM to pick one option,
  based on the entity's extracted values. Each option is
  `{ title, definition }`.

To use a predefined schema instead, return it as `{ schema }`. Its `id`,
`entityType`, `classifications`, and `fields` replace the defaults. Fields
can include `selectorCandidates` that you already know work:

```js
extraction: () => ({
  schema: {
    id: "restaurant_description",
    entityType: "FoodEstablishment",
    fields: [
      {
        name: "description",
        description: "The description of the food establishment.",
        dataType: "string",
        selectorCandidates: ["#accordion-body-1 .editor"],
      },
    ],
  },
}),
```

### Run the workflow

1. `create()` loads every page and asks the LLM for selector candidates: one
   call for the leaf fields at each level, and one call per array field for
   its container selector. Nested array fields use the HTML of the first
   matched item.
2. `run()` loads every page again and resolves each field. A leaf field takes
   the text of the first selector candidate that matches non-empty text. An
   array field produces one result per matched container. Classifications run
   after the entity's fields resolve. `run()` returns one
   `{ id, url, values }` entry per page.

### Read and save results

`create()` and `run()` keep schemas and pages in memory. To read them, use
these methods:

| Method | Returns |
| --- | --- |
| `getSchemas()` | Every schema. |
| `getSchema({ name })` | The schemas from the `extract()` call with this `name`. |
| `getPages()` | Every page. |
| `getPage({ name })` | The pages from the `extract()` call with this `name`, one per URL. |

`getSchema` and `getPage` match the `name` passed to `extract()`, not a
predefined schema's own `name`. Both return an empty array when nothing
matches.

To save them, use `persistSchema(schema)` and `persistPage(page)`. `run()`
saves each page's values itself.

| Path | Written by | Contents |
| --- | --- | --- |
| `schemas/<id>.json` | `persistSchema()` | The schema definition. |
| `pages/<url>/page-schema.json` | `persistPage()` | The page's fields with their selector candidates. |
| `pages/<url>/page-values.json` | `run()` | The values resolved on the last run. |

File and directory names are URL-encoded.

## Files

| File | Purpose |
| --- | --- |
| `extractor.js` | `createClient`, the schema builder, selector discovery, field resolution, and the save functions. |
| `lib/ai-sdk.js` | `createAI(model)`: the `AI` implementation for AI SDK language models. |
| `browser/index.js` | Headless Chromium page loading: Puppeteer locally, `@sparticuz/chromium-min` on Linux and serverless. |
| `index.js` | Example workflow for feinschmecker.de pages, using DeepSeek. |

## Known gaps

- **Each page loads twice.** `create()` and `run()` both fetch every page.
- **No selector repair.** `run()` uses the candidates from `create()` as-is.
  If a selector stops matching on a later run, nothing finds a new one.
- **`run()` saves values itself.** Unlike schemas and pages, the caller can't
  decide whether to save values.
- **Unused files.** Nothing references `lib/worker-pool.js`,
  `fixtures/restaurant-snapshot-v1.html`, or `logs/`.
- **External Chromium binary.** `CHROMIUM_PACK_URL` in `browser/index.js`
  points to an external bucket for the Linux and serverless Chromium build.
- **Crawling etiquette.** Respect `robots.txt` and rate limits before you
  crawl a third-party site on a schedule.
