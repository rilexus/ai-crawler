# ai-crawler

LLM-assisted web extraction. You describe the entities and fields you want
from a set of pages, and an LLM proposes CSS selectors for each field. Every
value comes from running a selector against the page HTML with `cheerio`, so
the LLM never supplies a value directly.

The extractor doesn't depend on a specific LLM provider. You inject an `AI`
object, and `lib/ai-sdk.js` provides one for any
[AI SDK](https://ai-sdk.dev) language model. `index.js` uses DeepSeek through
an OpenAI-compatible endpoint.

The project also controls the Brave browser directly over the
[Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
(CDP), without Puppeteer. You can find elements on a page, click them, and type
into them, and you can bundle those steps into reusable, validated _flows_
that an LLM can call as tools. See
[Automate a browser](#automate-a-browser).

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

3. To automate a browser, install [Brave](https://brave.com). The
   automation code expects it at
   `/Applications/Brave Browser.app`. To use another Chromium-based browser,
   set `CHROME_PATH` to its executable.

4. Run `index.js`:

   ```bash
   npm run dev
   ```

   `index.js` currently runs the `reddit_create_post` flow, which needs a copy
   of your Brave profile. The extraction workflow is commented out above it.

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

## Automate a browser

The browser automation code lives in `lib/chrome.js`, `lib/browser.js`,
`lib/page.js`, and `lib/flow.js`. The first three send CDP commands over the
`WebSocket` built into Node.js 22 and need no packages. `lib/flow.js` uses
`zod` and `ai`.

```js
const Browser = require("./lib/browser");

const browser = await new Browser({ headless: false }).launch();

try {
  const page = await browser.goto("https://example.com");
  await page.click(await page.findByText("Learn more"));
} finally {
  await browser.close();
}
```

### Start the browser

`new Browser(options)` stores the launch options. `browser.launch()` starts
Brave with remote debugging, connects to it, and resolves with the browser.
`browser.close()` quits it.

`lib/chrome.js` also gives you two ways to get a CDP connection to a browser
that's already running:

| Function | What it does |
| --- | --- |
| `connectToChrome(host)` | Connects to a browser that's already running with `--remote-debugging-port`. Defaults to `http://127.0.0.1:9222`. |
| `connectToRunningBrave()` | Connects to the Brave you have open, with your own profile. You must first allow remote debugging at `brave://inspect/#remote-debugging`, and Brave might ask you to approve each connection. |

The `Browser` constructor accepts these options:

| Option | Default | Description |
| --- | --- | --- |
| `headless` | `true` | Whether to run without a window. |
| `userDataDir` | A temporary profile | A profile directory to start from. `close()` keeps it. A temporary profile is deleted on `close()`. |
| `executablePath` | `CHROME_PATH`, then Brave | The browser executable. |
| `args` | `[]` | Extra command-line flags. |
| `timeout` | `30000` | Milliseconds to wait for the browser to start. |

#### Use your logins and cookies

Brave doesn't allow remote debugging on your default profile, so the crawler
starts from a copy of it. `copyBraveProfile(destination)` copies your Brave
profile, without its caches, and `index.js` keeps the copy in
`~/.ai-crawler/brave-profile`:

```js
const userDataDir = path.join(os.homedir(), ".ai-crawler", "brave-profile");
if (!existsSync(userDataDir)) await copyBraveProfile(userDataDir);

const browser = await new Browser({
  userDataDir,
  headless: false,
  args: ["--profile-directory=Default"],
}).launch();
```

Keep these points in mind:

- **The copy is a snapshot.** Logins you make later in your own Brave don't
  carry over. To refresh the copy, delete `~/.ai-crawler/brave-profile`, and
  the next run copies your profile again.
- **Quit Brave before copying.** `copyBraveProfile` refuses to copy while Brave
  is running, or to overwrite a copy that a crawler browser still uses.
- **macOS asks for access.** Reading Brave's profile requires Full Disk
  Access for the app you run Node.js from, such as Visual Studio Code or
  Terminal. Turn it on in **System Settings** > **Privacy & Security** >
  **Full Disk Access**, then restart that app. The first launch from the copy
  might also ask for access to **Brave Safe Storage** in the keychain, which
  Brave needs to decrypt your cookies.
- **The copy holds your cookies and saved logins.** Keep it outside the
  project, and don't commit or share it.

### Open pages

| Method | Returns |
| --- | --- |
| `browser.goto(url, { waitUntil })` | A `Page` for a new tab, once the page loads. |

`waitUntil` is `"load"` by default. Set it to `"networkidle"` to also wait
until the page makes no network requests for 500 ms. A page that never stops
making requests makes `"networkidle"` wait forever.

### Find elements

Each `find` method returns the element's CDP `objectId`, a string that you
pass to `click`, `type`, or `page.send`. An `objectId` stops working when the
page navigates or reloads.

| Method | Finds the element whose… |
| --- | --- |
| `page.findById(id)` | `id` attribute is `id`. |
| `page.findByText(text, { exact })` | Visible text is `text`. |
| `page.findByPlaceholderText(text, { exact })` | `placeholder` attribute is `text`. |
| `page.findByRole(role, { name, exact })` | ARIA role is `role`, such as `button` or `textbox`, and whose label is `name`. |

All four methods work the same way:

- **They wait.** Each method retries for up to 10 seconds until exactly one
  element matches. Pass `{ timeout }` in milliseconds to change the limit, or
  `{ timeout: 0 }` to check once.
- **They expect exactly one match.** They throw if nothing matches or if more
  than one element matches.
- **They search open shadow DOM.** Elements inside closed shadow roots and
  iframes aren't found.
- **They match text exactly by default.** Whitespace is normalized and
  matching is case-sensitive. Pass `{ exact: false }` to match text that
  contains the string.
- **They return the innermost match.** For `<button><span>Save</span></button>`,
  `findByText("Save")` returns the `<span>`. Clicking it still clicks the
  button.

`findByRole` uses the browser's accessibility tree, so built-in roles count:
a `<button>` has role `button` and a `<textarea>` has role `textbox`. The
`name` matches the element's accessible name, from its content, `<label>`,
`aria-label`, or `aria-labelledby`, and also its `placeholder` or
`aria-placeholder`.

To wait for any other condition, use `page.waitFor(callback, { timeout })`. It
calls `callback` until it returns without throwing.

### Click and type

| Method | What it does |
| --- | --- |
| `page.click(element)` | Scrolls the element into view and clicks its center with real mouse events. Throws if the element isn't displayed or another element covers it. |
| `page.type(element, text, { replace })` | Focuses a text field and inserts `text` at the end. With `{ replace: true }`, replaces the field's text. Works with `<input>`, `<textarea>`, and `contenteditable` editors. |
| `page.content()` | Returns the page's current HTML, without shadow DOM. |
| `page.html()` | Returns the page's current HTML, including open shadow roots as `<template shadowrootmode="open">` elements. |
| `page.toMarkdown()` | Converts the page's current HTML to Markdown with `markitdown-ts`. Leaves out content inside shadow DOM. |
| `page.url()` | Returns the page's current address. |
| `page.send(method, params)` | Sends any CDP command to this tab. |
| `page.close()` | Closes the tab. |

`type` fires `beforeinput` and `input` events, as typing or pasting does, but
no `keydown` or `keyup` events.

### Bundle interactions into flows

A _flow_ is a named, reusable sequence of page interactions. Define one with
`defineFlow` from `lib/flow.js`:

```js
const { z } = require("zod");
const { defineFlow } = require("../../lib/flow");

module.exports = defineFlow({
  name: "reddit_open_post_editor",
  description:
    "Opens the editor for a new Reddit post. Starts from any Reddit page while you're logged in.",
  input: z.object({}),

  async run(page, input, { step }) {
    await step("click Create", async () => {
      await page.click(await page.findByText("Create"));
    });
    await step("wait for the editor", async () => {
      await page.findByRole("textbox", { name: "Title", exact: false });
    });
  },
});
```

| Field | Description |
| --- | --- |
| `name` | Up to 64 letters, digits, underscores, or hyphens. Model providers reject tool names with other characters. |
| `description` | What the flow does and which page it starts from. An LLM reads this when it chooses a flow. |
| `input` | Optional. A Zod schema that validates the input and fills in defaults. |
| `output` | Optional. A Zod schema that validates the result. |
| `run(page, input, { step })` | The interactions. Wrap parts of it in `step(label, fn)` to name them in the log and in errors. |

`defineFlow` returns an async function. Call it with a page and an input, as
you would any function, including from inside another flow:

```js
const createPost = require("./flows/reddit/create-post");

const { url } = await createPost(page, { title: "Hello", subreddit: "r/test" });
```

As a flow runs, it logs each flow and step, indented by depth. When something
fails, it throws a `FlowError` whose message starts with the chain of flows
and steps that led to the failure:

```text
reddit_create_post > publish: Timed out after 10000 ms. Last error: No element with role "button" and name "Post".
```

`error.path` holds that chain as an array, and `error.cause` holds the
original error.

Return data from a flow, such as text or URLs, not element `objectId` values,
because those stop working after the page navigates.

#### Let an LLM call flows

`toTools(page, flows)` turns flows into [AI SDK](https://ai-sdk.dev) tools
that run on `page`. The LLM picks the flows and fills in their inputs, and
the input schemas reject bad arguments before the browser does anything:

```js
const { generateText, stepCountIs } = require("ai");
const { toTools } = require("./lib/flow");

await generateText({
  model,
  tools: toTools(page, [createPost, openPostEditor]),
  stopWhen: stepCountIs(10),
  prompt: "Write a draft post titled 'Hello' in r/test.",
});
```

#### Reddit flows

| Flow | File | What it does |
| --- | --- | --- |
| `reddit_open_post_editor` | `flows/reddit/open-post-editor.js` | Clicks **Create** and waits for the post editor. |
| `reddit_create_post` | `flows/reddit/create-post.js` | Opens the editor, picks the subreddit, and fills in the title and body. Publishes only when `publish` is `true`. Returns `{ url, published }`. |

`reddit_create_post` takes these inputs:

| Input | Required | Description |
| --- | --- | --- |
| `title` | Yes | 1 to 300 characters. |
| `subreddit` | Yes | The subreddit as Reddit's list shows it, with its prefix, such as `r/test`. |
| `body` | No | The post text. Defaults to empty. |
| `publish` | No | Whether to publish. Defaults to `false`, which leaves the draft open. |

Both flows need a profile that's logged in to Reddit. They depend on Reddit's
current page structure and labels, so they break when Reddit changes them.

## Files

| File | Purpose |
| --- | --- |
| `extractor.js` | `createClient`, the schema builder, selector discovery, field resolution, and the save functions. |
| `lib/ai-sdk.js` | `createAI(model)`: the `AI` implementation for AI SDK language models. |
| `browser/index.js` | Headless Chromium page loading for the extractor: Puppeteer locally, `@sparticuz/chromium-min` on Linux and serverless. |
| `lib/chrome.js` | `CDPConnection`, plus functions to connect to a running browser and to copy a Brave profile. |
| `lib/browser.js` | `Browser`: launches and closes Brave, and opens tabs with `goto`. |
| `lib/page.js` | `Page`: finds elements, clicks, types, and waits in one tab. |
| `lib/flow.js` | `defineFlow`, `step`, `toTools`, and `FlowError`. |
| `flows/reddit/` | The Reddit flows. |
| `index.js` | Runs the `reddit_create_post` flow in Brave. The DeepSeek extraction workflow is commented out. |

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
- **Two browser classes.** The extractor still uses `browser/index.js`, which
  is built on Puppeteer. `lib/browser.js` has no `loadHTML`, so it can't
  replace it yet.
- **macOS only.** The Brave paths in `lib/chrome.js` are macOS paths.
- **No keyboard events.** `page.type` doesn't fire `keydown` or `keyup`, and
  there's no way to press keys such as Enter.
- **No iframes or closed shadow roots.** The `find` methods don't search them.
- **Browser left open.** `index.js` doesn't call `close()`, so the crawler's
  Brave window stays open after a run.
- **Crawling etiquette.** Respect `robots.txt` and rate limits before you
  crawl a third-party site on a schedule.
