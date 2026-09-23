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

let browser = null;
let browserReady = null;

function resetBrowser() {
  browser = null;
  browserReady = null;
}

async function doLaunch() {
  if (process.platform !== "linux") {
    const { default: puppeteerFull } = await import("puppeteer");
    const b = await puppeteerFull.launch({
      headless: true,
      args: ["--ignore-certificate-errors"],
    });
    b.on("disconnected", resetBrowser);
    return b;
  }

  const executablePath = await getChromiumPath();
  const chromium = (await import("@sparticuz/chromium-min")).default;
  const puppeteer = await import("puppeteer-core");

  const b = await puppeteer.launch({
    args: [
      ...chromium.args,
      "--no-sandbox",
      "--ignore-certificate-errors",
      "--font-render-hinting=none",
    ],
    executablePath,
    headless: true,
  });
  b.on("disconnected", resetBrowser);
  return b;
}

async function launchBrowser() {
  if (browser) {
    return browser;
  }
  if (!browserReady) {
    browserReady = doLaunch()
      .then((b) => {
        browser = b;
        return b;
      })
      .catch((err) => {
        resetBrowser();
        throw err;
      });
  }
  return browserReady;
}

async function generatePDFfromURL(url) {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.evaluate(`
    Promise.all(
      Array.from(document.images)
        .filter(img => !img.complete)
        .map(img => new Promise(resolve => { img.onload = img.onerror = resolve; }))
    )
  `);
  const pdfBuffer = await page.pdf({ printBackground: true, format: "A4" });
  await browser.close();
  return pdfBuffer;
}

async function loadPageFromUrl(url) {
  const browser = await launchBrowser();

  const page = await browser.newPage();

  await page.goto(url, { waitUntil: "networkidle0" });
  const html = await page.content();

  return {
    page: cheerio.load(html),
    html: html,
  };
}

module.exports = { launchBrowser, generatePDFfromURL, loadPageFromUrl };
