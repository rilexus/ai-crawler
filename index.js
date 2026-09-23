process.loadEnvFile();

const { createClient } = require("./extractor");

async function main() {
  const client = createClient();

  const workflow = await client
    .extract({
      name: "Restaurant",
      url: "https://www.wilma-wunder.de/restaurants/passau/",
      extraction: (builder) => {
        builder
          .entity("Restaurant")
          .field("name", "The name of the restaurant on the page.", "string")
          .field("description", "The description of the restaurant.", "string")
          .field(
            "openingHours",
            "The opening hours of the restaurant.",
            "string",
          )
          .field(
            "contactPoint",
            "Contact information like email, phone etc.",
            "object",
            (builder) => {
              builder
                .entity("ContactPoint")
                .field("email", "Email of the restaurant", "string")
                .field("url", "Website URL of the restaurant", "string")
                .field(
                  "telephone",
                  "Telephone number of the restaurant",
                  "string",
                );
            },
          );
      },
    })
    .create();

  await workflow.run();

  // console.log(workflow.schemas);
}

main();
