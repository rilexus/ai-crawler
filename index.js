process.loadEnvFile();
const { createOpenAICompatible } = require("@ai-sdk/openai-compatible");
const { createClient, persistPage, persistSchema } = require("./extractor");
const { createAI } = require("./lib/ai-sdk");
const Browser = require("./lib/browser");
const { existsSync } = require("node:fs");
const { writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { copyBraveProfile } = require("./lib/chrome");
const createPost = require("./flows/reddit/create-post");

const deepseek = createOpenAICompatible({
  name: "deepseek",
  baseURL: `${process.env.DEEP_SEEK_API_URL}`,
  apiKey: process.env.DEEP_SEEK_API_KEY,
});

async function main() {
  // The copy holds your cookies, so keep it outside the project. Delete the
  // folder to take a fresh snapshot on the next run.
  const userDataDir = path.join(os.homedir(), ".ai-crawler", "brave-profile");
  if (!existsSync(userDataDir)) await copyBraveProfile(userDataDir);

  const browser = await new Browser({
    userDataDir,
    headless: false,
    args: ["--profile-directory=Default"],
  }).launch();

  const client = createClient(
    browser,
    createAI(deepseek(process.env.DEEP_SEEK_MODEL_NAME || "deepseek-chat")),
  );

  const workflow = await client
    .extract({
      name: "restaurant",
      urls: [
        "https://bidlabu.de/",
        "https://lohninger.de/",
        "https://www.maintower-restaurant.de/",
      ],
      extraction: (builder) => {
        return builder
          .entity("Restaurant")
          .field("name", "The name of the restaurant.", "string")
          .field("address", "The address of the restaurant.", "string");
      },
    })
    .create();

  const schemas = await workflow.getSchemas();
  for (const schema of schemas) {
    await persistSchema(schema);
  }

  await workflow.run();
  const pages = await workflow.getPages();
  if (!pages.length) throw new Error("No pages found!");
  for (const page of pages) {
    await persistPage(page);
  }

  // try {
  //   const page = await browser.goto(
  //     "https://www.reddit.com/r/cofounderhunt/comments/1x1fa40/looking_for_a_cofounder_who_values_character_over/",
  //   );
  //   const markdown = await page.toMarkdown();

  //   const { hostname } = new URL(await page.url());
  //   const time = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
  //   const file = path.join(os.homedir(), "Desktop", `${hostname}-${time}.md`);
  //   await writeFile(file, markdown);
  //   console.log(`Saved ${file}`);
  // } finally {
  //   await browser.close();
  // }
}

main();
