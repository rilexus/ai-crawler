const cheerio = require("cheerio");

const CHROMIUM_PACK_URL = `https://storage.googleapis.com/delta-renderer/chromium-pack.tar`;

let cachedExecutablePath = null;
let downloadPromise = null;

async function getChromiumPath() {
  if (cachedExecutablePath) return cachedExecutablePath;

  if (!downloadPromise) {
    const chromium = (await import("@sparticuz/chromium-min")).default;
    downloadPromise = chromium
      .executablePath(CHROMIUM_PACK_URL)
      .then((path) => {
        cachedExecutablePath = path;
        return path;
      })
      .catch((error) => {
        downloadPromise = null;
        throw error;
      });
  }

  return downloadPromise;
}

async function launch() {
  if (process.platform !== "linux") {
    const { default: puppeteerFull } = await import("puppeteer");
    return puppeteerFull.launch({
      headless: true,
      args: ["--ignore-certificate-errors"],
    });
  }

  const executablePath = await getChromiumPath();
  const chromium = (await import("@sparticuz/chromium-min")).default;
  const puppeteer = await import("puppeteer-core");

  return puppeteer.launch({
    args: [
      ...chromium.args,
      "--no-sandbox",
      "--ignore-certificate-errors",
      "--font-render-hinting=none",
    ],
    executablePath,
    headless: true,
  });
}

// A headless Chromium instance. It launches on first use, and `close()` shuts
// it down. The Chromium process keeps Node alive until then.
class Browser {
  #launching = null;

  async #instance() {
    if (!this.#launching) {
      const launching = launch().then(
        (browser) => {
          browser.on("disconnected", () => {
            if (this.#launching === launching) this.#launching = null;
          });
          return browser;
        },
        (error) => {
          if (this.#launching === launching) this.#launching = null;
          throw error;
        },
      );
      this.#launching = launching;
    }
    return this.#launching;
  }

  async #withPage(url, callback) {
    const browser = await this.#instance();
    const page = await browser.newPage();

    try {
      await page.goto(url, { waitUntil: "networkidle0" });
      return await callback(page);
    } finally {
      await page.close();
    }
  }

  async loadHTML(url) {
    return this.#withPage(url, async (page) => {
      return page.content();
    });
  }

  async loadPage(url) {
    return this.#withPage(url, async (page) => {
      return cheerio.load(await page.content());
    });
  }

  async generatePDFfromURL(url) {
    return this.#withPage(url, async (page) => {
      await page.evaluate(`
        Promise.all(
          Array.from(document.images)
            .filter(img => !img.complete)
            .map(img => new Promise(resolve => { img.onload = img.onerror = resolve; }))
        )
      `);
      return page.pdf({ printBackground: true, format: "A4" });
    });
  }

  async close() {
    // Clear before awaiting, so a page load that starts during shutdown
    // launches a new instance instead of reusing the closing one.
    const launching = this.#launching;
    this.#launching = null;
    const browser = await launching?.catch(() => null);
    await browser?.close();
  }
}

module.exports = Browser;
