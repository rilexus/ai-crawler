process.loadEnvFile();

const { createClient } = require("./extractor");
const Browser = require("./browser");

const schema = {
  id: "randomId_1",
  name: `FoodEstablishment`,
  entityType: "FoodEstablishment",
  classifications: [],
  fields: [
    {
      name: "name",
      description: "The name of the food establishment on the page.",
      dataType: "string",
      selectorCandidates: [".location-detail__title"],
    },
    {
      name: "description",
      description: "The description of the food establishment.",
      dataType: "string",
      selectorCandidates: ["#accordion-body-1 .editor"],
    },
    {
      name: "type",
      description:
        "The type of the food establishment. Example: Restaurant, CafeOrCoffeeShop, Bakery, Winery",
      dataType: "string",
      selectorCandidates: ['[class="location-detail__type"]'],
    },
    {
      name: "openingHours",
      description: "The opening hours of the restaurant.",
      dataType: "string",
      selectorCandidates: ['[class="location-detail__sidebar-opening-hours"]'],
    },
    {
      name: "servesCuisine",
      entityType: "cuisineType",
      description:
        "The types of cuisine the restaurant serves. Example: Fusion, Saisonal or Greek.",
      dataType: "array",
      selectorCandidates: [
        ".location-detail__types-row:nth-child(2) .location-detail__types-tag",
        ".location-detail__types-row:nth-of-type(2) .location-detail__types-tags > .location-detail__types-tag",
        ".location-detail__types-tags > .location-detail__types-tag",
        ".location-detail__types-tag",
      ],
      classifications: [],
      fields: [
        {
          name: "name",
          description: "One specific cuisine type.",
          dataType: "string",
          selectorCandidates: ["div.location-detail__types-tag"],
        },
      ],
    },
    {
      name: "contactPoint",
      entityType: "ContactPoint",
      description: "Contact information like email, phone etc.",
      dataType: "object",
      selectorCandidates: [],
      classifications: [],
      fields: [
        {
          name: "email",
          description: "Email of the restaurant.",
          dataType: "string",
          selectorCandidates: ['a[href^="mailto:"]'],
        },
        {
          name: "website",
          description: "Website URL of the restaurant.",
          dataType: "string",
          selectorCandidates: [
            'a[href="https://thecloud.restaurant/"]',
            '.location-detail__sidebar-contact a[target="_blank"]',
          ],
        },
        {
          name: "instagram",
          description: "Link to the instagram page of the food establishment.",
          dataType: "string",
          selectorCandidates: [
            'a[href^="https://www.instagram.com/thecloudbykaefer"]',
            '.location-detail__sidebar-contact a[href*="instagram.com"]',
          ],
        },
        {
          name: "telephone",
          description: "Telephone number of the restaurant",
          dataType: "string",
          selectorCandidates: ['a[href^="tel:"]'],
        },
      ],
    },
  ],
};

async function main() {
  const client = createClient(new Browser());

  const workflow = await client
    .extract({
      name: "café-faller-fe",
      urls: [
        "https://www.feinschmecker.de/restaurant/de/köln/neo|biota-6c",
        "https://www.feinschmecker.de/weingut/de/st.-martin/wein-&-sekthaus-alois-kiefer---weingut-aloisiushof-3c",
        "https://www.feinschmecker.de/baecker/de/staufen-im-breisgau/bäckerei-café-faller-fe",
      ],
      extraction: (builder) => {
        return builder
          .entity("Bäckerei")
          .field("name", "The name of the bakery.", "string");
      },
    })
    .create();

  await workflow.run();
}

main();
