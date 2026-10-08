process.loadEnvFile();
const { createOpenAICompatible } = require("@ai-sdk/openai-compatible");
const { createClient, persistPage, persistSchema } = require("./extractor");
const { createAI } = require("./lib/ai-sdk");
const Browser = require("./lib/browser");
const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { copyBraveProfile, launchChrome } = require("./lib/chrome");
const createPost = require("./flows/reddit/create-post");

const deepseek = createOpenAICompatible({
  name: "deepseek",
  baseURL: `${process.env.DEEP_SEEK_API_URL}`,
  apiKey: process.env.DEEP_SEEK_API_KEY,
});

async function main() {
  // const client = createClient(
  //   new Browser(),
  //   createAI(deepseek(process.env.DEEP_SEEK_MODEL_NAME || "deepseek-chat")),
  // );

  // const workflow = await client
  //   .extract({
  //     name: "bidlabu",
  //     urls: ["https://bidlabu.de/"],
  //     extraction: (builder) => {
  //       return builder
  //         .entity("Restaurant")
  //         .field(
  //           "hasMenus",
  //           "Menus served by the restaurant.",
  //           "array",
  //           (builder) =>
  //             builder
  //               .entity("Menu")
  //               .field("name", "The name of the menu.", "string"),
  //         );
  //     },
  //   })
  //   .create();

  // const schemas = await workflow.getSchemas();
  // for (const schema of schemas) {
  //   await persistSchema(schema);
  // }

  // await workflow.run();
  // const pages = await workflow.getPages();
  // if (!pages.length) throw new Error("No pages found!");
  // for (const page of pages) {
  //   await persistPage(page);
  // }

  // The copy holds your cookies, so keep it outside the project. Delete the
  // folder to take a fresh snapshot on the next run.
  const userDataDir = path.join(os.homedir(), ".ai-crawler", "brave-profile");
  if (!existsSync(userDataDir)) await copyBraveProfile(userDataDir);

  const { connection, close } = await launchChrome({
    userDataDir,
    headless: false,
    args: ["--profile-directory=Default"],
  });
  const browser = new Browser(connection);

  try {
    const page = await browser.goto("https://reddit.com");
    // Pass `publish: true` to post it.
    const result = await createPost(page, {
      title: "here we go!",
      body: "here we go!",
      subreddit: "r/test",
    });
    console.log(result);
  } finally {
    // await close();
  }
}

main();
