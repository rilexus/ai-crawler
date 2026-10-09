const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { CDPConnection } = require("./chrome");
const Page = require("./page");

/**
 * Maps `waitUntil` options to the Chrome lifecycle events that end a
 * navigation. `networkIdle` fires once the page has had no network requests
 * for 500 ms, like Puppeteer's `networkidle0`.
 */
const LIFECYCLE_EVENTS = {
  load: "load",
  networkidle: "networkIdle",
};

const BRAVE_PATH =
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

/**
 * Resolves the browser binary to launch: `CHROME_PATH` if set, otherwise
 * Brave.
 *
 * @returns {string}
 */
function defaultExecutablePath() {
  return process.env.CHROME_PATH || BRAVE_PATH;
}

/**
 * Waits for Chrome to print its DevTools WebSocket endpoint on stderr.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} timeout Milliseconds to wait before giving up.
 * @returns {Promise<string>}
 */
function waitForEndpoint(child, timeout) {
  return new Promise((resolve, reject) => {
    let output = "";

    const cleanup = () => {
      clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    const onData = (chunk) => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        cleanup();
        resolve(match[1]);
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(
        new Error(
          `Chrome exited with code ${code} before it was ready.\n${output}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out after ${timeout} ms waiting for Chrome.\n${output}`,
        ),
      );
    }, timeout);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", onData);
    child.on("exit", onExit);
  });
}

class Browser {
  #options;
  #child;
  #userDataDir;

  /**
   * Stores the launch options. Call `launch()` to start the browser.
   *
   * @param {object} [options]
   * @param {string} [options.executablePath] The browser binary. Defaults to
   *   `CHROME_PATH`, then Brave.
   * @param {boolean} [options.headless=true] Whether to run without a window.
   * @param {string[]} [options.args] Extra Chrome command-line flags.
   * @param {number} [options.timeout=30000] Milliseconds to wait for startup.
   * @param {string} [options.userDataDir] A profile directory to reuse, such
   *   as one from `copyBraveProfile`. `close` keeps it. Without it, the
   *   browser gets a temporary profile that `close` deletes.
   */
  constructor({
    executablePath,
    headless = true,
    args = [],
    timeout = 30_000,
    userDataDir,
  } = {}) {
    this.#options = { executablePath, headless, args, timeout, userDataDir };
    /** @type {CDPConnection | undefined} */
    this.connection = undefined;
  }

  /**
   * Starts the browser with remote debugging on and connects to it over CDP.
   *
   * @returns {Promise<this>}
   */
  async launch() {
    if (this.#child) throw new Error("The browser is already launched.");

    const { executablePath, headless, args, timeout, userDataDir } =
      this.#options;
    this.#userDataDir =
      userDataDir ??
      (await fs.mkdtemp(path.join(os.tmpdir(), "ai-crawler-chrome-")));

    this.#child = spawn(
      executablePath ?? defaultExecutablePath(),
      [
        "--remote-debugging-port=0",
        `--user-data-dir=${this.#userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        ...(headless ? ["--headless=new"] : []),
        ...args,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    try {
      const endpoint = await waitForEndpoint(this.#child, timeout);
      this.connection = await CDPConnection.connect(endpoint);
    } catch (error) {
      await this.close();
      throw error;
    }

    return this;
  }

  /**
   * Quits the browser. Deletes the profile unless you passed `userDataDir`.
   */
  async close() {
    const child = this.#child;
    if (!child) return;

    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      // Ask the browser to quit so it saves cookies and removes its profile
      // lock. Kill it only if it doesn't exit in time.
      await this.connection?.send("Browser.close").catch(() => {});
      const timer = setTimeout(() => child.kill(), 5_000);
      if (!this.connection) child.kill();
      await exited;
      clearTimeout(timer);
    }
    this.connection?.close();
    if (!this.#options.userDataDir) {
      await fs.rm(this.#userDataDir, { recursive: true, force: true });
    }

    this.#child = undefined;
    this.connection = undefined;
  }

  /**
   * Opens a new tab, navigates it to `url`, and waits for it to finish
   * loading.
   *
   * @param {string} url The address to open.
   * @param {object} [options]
   * @param {"load" | "networkidle"} [options.waitUntil="load"] When the
   *   navigation counts as finished: at the `load` event, or once the page
   *   has had no network requests for 500 ms.
   * @returns {Promise<Page>} The open tab.
   */
  async goto(url, { waitUntil = "load" } = {}) {
    if (!this.connection) throw new Error("Call launch() before goto().");

    const lifecycleEvent = LIFECYCLE_EVENTS[waitUntil];
    if (!lifecycleEvent) {
      throw new Error(
        `Unknown waitUntil "${waitUntil}". Use one of: ${Object.keys(LIFECYCLE_EVENTS).join(", ")}.`,
      );
    }

    const { targetId } = await this.connection.send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await this.connection.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });

    // Record lifecycle events before navigating so none slip past while
    // `Page.navigate` is in flight. Events from other tabs share the
    // connection, so match on the session.
    const seen = new Set();
    let onReached;
    const onLifecycle = ({ frameId, loaderId, name }, eventSessionId) => {
      if (eventSessionId !== sessionId || name !== lifecycleEvent) return;
      seen.add(`${frameId}:${loaderId}`);
      onReached?.();
    };
    this.connection.on("Page.lifecycleEvent", onLifecycle);

    try {
      await this.connection.send("Page.enable", {}, sessionId);
      await this.connection.send(
        "Page.setLifecycleEventsEnabled",
        { enabled: true },
        sessionId,
      );

      const { frameId, loaderId, errorText } = await this.connection.send(
        "Page.navigate",
        { url },
        sessionId,
      );
      if (errorText) throw new Error(`Failed to open ${url}: ${errorText}`);

      // Only the new document's events count, not the initial about:blank's.
      const key = `${frameId}:${loaderId}`;
      await new Promise((resolve) => {
        onReached = () => seen.has(key) && resolve();
        onReached();
      });
    } catch (error) {
      await this.connection
        .send("Target.closeTarget", { targetId })
        .catch(() => {});
      throw error;
    } finally {
      this.connection.off("Page.lifecycleEvent", onLifecycle);
    }

    return new Page(this.connection, targetId, sessionId);
  }
}

module.exports = Browser;
