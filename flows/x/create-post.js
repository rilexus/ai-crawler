import z from "zod";
import { defineFlow } from "../../lib/flow.js";

export const createPost = defineFlow({
  name: "create_post",
  description: `Create a post on "https://www.x.com". `,
  input: z.object({
    text: z.string().describe("Text to post."),
  }),
  run: async (page, { text }, { step }) => {
    const textbox = await step("find input", async () => {
      return page.findByRole("textbox");
    });

    await step("click input", async () => {
      return page.click(textbox);
    });

    await step("type", async () => {
      return page.type(textbox, text);
    });

    await step("post", async () => {
      const button = await page.findByTestId("tweetButtonInline");
      // return page.click(button);
    });
  },
});
