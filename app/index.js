import express from "express";
import Browser from "../lib/browser.js";
import Workflow from "../lib/workflow.js";
import { createPost } from "../flows/x/create-post.js";

// The workflow server in workflow/server/index.js uses port 3000.
const PORT = Number(process.env.APP_PORT) || 3001;

// Resolves after `ms` milliseconds.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const workflow = new Workflow({ id: "my-app" });

await workflow.create(
  {
    id: "my-workflow",
    triggers: { event: { type: "event/start-my-workflow" } },
  },
  async ({ step }) => {
    // Each step sleeps, so you can watch its status change in the web app.
    const first = await step("first", async () => {
      await sleep(2000);
      console.log("first");
      return 1;
    });

    const second = await step("second", async () => {
      await sleep(2000);
      console.log("second");
      // Fails half the time, to test error handling.
      if (Math.random() < 0.5) throw new Error("test error");
      return 2;
    });

    const third = await step("third", async () => {
      await sleep(2000);
      console.log("third");
      return 3;
    });

    return { first, second, third };
  },
);

await workflow.create(
  {
    id: "create-twitter-posts",
    triggers: { event: { type: "event/start-collect-x-posts" } },
  },
  async ({ step }) => {
    let browser = null;

    await step("open browser", async () => {
      browser = await new Browser().connect();
      return true;
    });

    let page = null;
    await step("navigate", async () => {
      page = await browser.goto("https://www.x.com");
      return true;
    });

    await step("create post", async () => {
      await createPost(page, { text: "hello world!" });
    });

    await step("close browser", async () => {
      if (browser) {
        await browser.close();
      }
    });
  },
);

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// The workflow server syncs with this path (WORKFLOW_APP_URLS on the server)
// and sends events to it.
app.use(
  "/api/workflow",
  workflow.serve({ serveHost: `http://localhost:${PORT}` }),
);

app.use((req, res) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`App listening on http://localhost:${PORT}`);
});
