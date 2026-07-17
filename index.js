const { createClient } = require("./extractor");

async function main() {
  const client = createClient();

  const workflow = await client
    .extract({
      url: "https://www.wilma-wunder.de/restaurants/passau/",
      name: "Address",
      extraction: (builder) =>
        builder
          .entity("PostalAddress")
          .field("streetAddress", "Street name", "string")
          .field("postalCode", "Postal code", "string")
          .field("addressCountry", "Country name", "string"),
    })
    .extract({
      url: "https://www.wilma-wunder.de/restaurants/passau/",
      name: "Review",
      extraction: (builder) => {
        builder
          .entity("Review")
          .field("reviewBody", "The text of the review", "string")
          .field("reviewRating", "The rating given in this review.", "string")
          .field("author", "Author of the review", "string")
          .classify("sentiment", "Content tone", [
            { title: "Positive", definition: "Optimistic tone" },
            { title: "Negative", definition: "Critical tone" },
            { title: "Neutral", definition: "Balanced tone" },
          ]);
      },
    })
    .create();

  await workflow.run();

  console.log(workflow.schemas);
}

main();
