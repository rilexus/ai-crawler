process.loadEnvFile();

const { createOpenAICompatible } = require("@ai-sdk/openai-compatible");
const { createClient, persistPage, persistSchema } = require("./extractor");
const { createAI } = require("./lib/ai-sdk");
const Browser = require("./browser");

const deepseek = createOpenAICompatible({
  name: "deepseek",
  baseURL: `${process.env.DEEP_SEEK_API_URL}`,
  apiKey: process.env.DEEP_SEEK_API_KEY,
});

async function main() {
  const client = createClient(
    new Browser(),
    createAI(deepseek(process.env.DEEP_SEEK_MODEL_NAME || "deepseek-chat")),
  );

  const workflow = await client
    .extract({
      name: "bidlabu",
      urls: ["https://bidlabu.de/"],
      extraction: (builder) => {
        return builder
          .entity("Restaurant")
          .field("menus", "Menus of the restaurant", "array", (builder) => {
            return builder
              .entity("Menu")
              .field("name", "The title of the menu.", "string");
          });
      },
    })
    // .extract({
    //   name: "feinschmecker",
    //   urls: ["https://www.feinschmecker.de/restaurant/de/köln/neo|biota-6c"],
    //   extraction: (builder) => {
    //     return builder
    //       .entity("Bäckerei")
    //       .field("name", "The name of the bakery.", "string");
    //   },
    // })
    // .extract({
    //   name: "restaurant_description",
    //   urls: [
    //     "https://www.feinschmecker.de/baecker/de/staufen-im-breisgau/bäckerei-café-faller-fe",
    //     "https://www.feinschmecker.de/weingut/de/st.-martin/wein-&-sekthaus-alois-kiefer---weingut-aloisiushof-3c",
    //   ],
    //   extraction: () => {
    //     return {
    //       schema: {
    //         id: "restaurant_description",
    //         name: "restaurant_description",
    //         entityType: "FoodEstablishment",
    //         classifications: [],
    //         fields: [
    //           {
    //             name: "description",
    //             description: "The description of the food establishment.",
    //             dataType: "string",
    //           },
    //         ],
    //       },
    //     };
    //   },
    // })
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
}

main();
