import { z } from "zod";
import { defineFlow } from "../../lib/flow.js";

export default defineFlow({
  name: "reddit_open_post_editor",
  description:
    "Opens the editor for a new Reddit post. Starts from any Reddit page while you're logged in. Ends with the editor's title field ready.",
  input: z.object({}),

  async run(page, _input, { step }) {
    await step("click Create", async () => {
      await page.click(await page.findByText("Create"));
    });

    await step("wait for the editor", async () => {
      await page.findByRole("textbox", { name: "Title", exact: false });
    });
  },
});
