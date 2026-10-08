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

class Browser {
  /**
   * @param {import("./chrome").CDPConnection} connection A browser-level CDP
   *   connection.
   */
  constructor(connection) {
    this.connection = connection;
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

  /**
   * Loads `url` in a new tab and returns the page's rendered HTML, including
   * the doctype. Closes the tab afterward.
   *
   * @param {string} url The address to load.
   * @param {object} [options] The same options as `goto`.
   * @param {"load" | "networkidle"} [options.waitUntil="load"]
   * @returns {Promise<string>}
   */
  async loadHTML(url, options) {
    const page = await this.goto(url, options);
    try {
      return await page.content();
    } finally {
      await page.close();
    }
  }
}

module.exports = Browser;
