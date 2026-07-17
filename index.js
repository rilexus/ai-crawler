const { createClient } = require("./extractor");

async function main() {
  const client = createClient();

  const workflow = await client
    .extract({
      url: "https://www.wilma-wunder.de/restaurants/passau/",
      name: "Restaurant",
      extraction: (builder) =>
        builder
          .entity("Restaurant")
          .field("name", "The name of the restaurant on the page", "string")
          .field(
            "review",
            "The reviews of the restaurant",
            "array",
            (builder) => {
              builder
                .entity("Review")
                .field("reviewBody", "The text of the review", "string")
                .field(
                  "reviewRating",
                  "The rating given in this review.",
                  "string",
                )
                .field("author", "Author of the review", "string")
                .field(
                  "comment",
                  "Comments of other users to the review",
                  "array",
                  (builder) => {
                    builder
                      .entity("Comment")
                      .field("text", "The text of the comment", "string")
                      .field(
                        "author",
                        "The author of the comment",
                        "object",
                        (builder) => {
                          builder
                            .entity("Person")
                            .field(
                              "name",
                              "The authors name of the review comment",
                              "string",
                            );
                        },
                      );
                  },
                )
                .classify("sentiment", "Content tone", [
                  { title: "Positive", definition: "Optimistic tone" },
                  { title: "Negative", definition: "Critical tone" },
                  { title: "Neutral", definition: "Balanced tone" },
                ]);
            },
          ),
    })
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
    .create();

  await workflow.run();

  console.log(workflow.schemas);
}

main();
