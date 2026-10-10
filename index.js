process.loadEnvFile();
const { createOpenAICompatible } = require("@ai-sdk/openai-compatible");
const { createClient, persistPage, persistSchema } = require("./extractor");
const { createAI } = require("./lib/ai-sdk");
const Browser = require("./lib/browser");
const { existsSync } = require("node:fs");
const { readFile, writeFile } = require("node:fs/promises");
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

  const menuItemSchema = await client.schema.createSchema({
    name: "MenuItem",
    entity: "MenuItem",
    fields: [
      {
        name: "name",
        description: "Menu item name",
        fieldType: "SCHEMA",
        dataType: "string",
        example: "Noodles",
      },
      {
        name: "description",
        description: "Menu item description",
        fieldType: "SCHEMA",
        dataType: "string",
      },
      {
        name: "price",
        description: "Menu item price",
        fieldType: "SCHEMA",
        dataType: "money",
      },
    ],
  });

  const workflow = await client
    .extract({
      name: "restaurant",
      urls: ["https://bidlabu.de/"],
      // html: await readFile(
      //   path.join(__dirname, "fixtures", "restaurant-snapshot-v1.html"),
      //   "utf8",
      // ),
      extraction: (builder) => {
        return builder
          .entity("Restaurant")
          .field(
            "hasMenus",
            "Offered menus by the restaurant.",
            "array",
            (builder) =>
              builder
                .entity("Menu")
                .field(
                  "name",
                  "The name of a specific menu offered.",
                  "string",
                ),
          );
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
