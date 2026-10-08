const { z } = require("zod");
const { defineFlow } = require("../../lib/flow");
const openPostEditor = require("./open-post-editor");

module.exports = defineFlow({
  name: "reddit_create_post",
  description:
    "Writes a text post on a specific subreddit on Reddit and, if `publish` is true, publishes it. Starts from any Reddit page while you're logged in.",
  input: z.object({
    title: z.string().min(1).max(300),
    body: z.string().default(""),
    subreddit: z.string().describe("The name of the subreddit."),
    publish: z
      .boolean()
      .default(false)
      .describe(
        "Whether to publish the post. If false, leaves the draft open.",
      ),
  }),
  output: z.object({
    url: z.string().url(),
    published: z.boolean(),
  }),

  async run(page, { title, body, publish, subreddit }, { step }) {
    await openPostEditor(page);

    await step("click on community picker", async () => {
      const picker = await page.findById("post-submit-community-picker");
      await page.click(picker);
      await page.findByText("Choose community");
    });

    await step("find subreddit", async () => {
      // The field's label reads "Search communities". Its placeholder,
      // "Search", may also match other search fields.
      const searchField = await page.findByRole("textbox", {
        name: "Search communities",
      });
      await page.click(searchField);

      await page.type(searchField, subreddit);

      const subredditButton = await page.findByText(subreddit);
      await page.click(subredditButton);

      await page.findById("title");
    });

    await step("enter the title", async () => {
      const field = await page.findByRole("textbox", {
        name: "Title",
        exact: false,
      });
      await page.type(field, title, { replace: true });
    });

    if (body) {
      await step("enter the body", async () => {
        const field = await page.findByRole("textbox", {
          name: "body",
          exact: false,
          timeout: 20_000,
        });
        await page.type(field, body, { replace: true });
      });
    }

    if (publish) {
      await step("publish", async () => {
        await page.click(await page.findByRole("button", { name: "Post" }));
        // Reddit opens the new post once it's published.
        await page.waitFor(async () => {
          if (!(await page.url()).includes("/comments/")) {
            throw new Error("The post page didn't open.");
          }
        });
      });
    }

    return { url: await page.url(), published: publish };
  },
});
