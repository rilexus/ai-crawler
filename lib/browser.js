import { connectToRunningBrave } from "./chrome.js";
import Page from "./page.js";

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
  #userDataDir;

  /**
   * Stores the connection options. Call `connect()` to attach to the Brave
   * you have open.
   *
   * @param {object} [options]
   * @param {string} [options.userDataDir] Brave's user data directory.
   *   Defaults to the one of your installed Brave.
   */
  constructor({ userDataDir } = {}) {
    this.#userDataDir = userDataDir;
    /** @type {import("./chrome.js").CDPConnection | undefined} */
    this.connection = undefined;
  }

  /**
   * Attaches to the Brave you have open over CDP, so tabs open in your
   * current window with your logins. Allow remote debugging at
   * `brave://inspect/#remote-debugging` first.
   *
   * @returns {Promise<this>}
   */
  async connect() {
    if (this.connection) throw new Error("The browser is already connected.");

    this.connection = await connectToRunningBrave(this.#userDataDir);
    return this;
  }

  /**
   * Disconnects from the browser. Brave and its tabs stay open; close the
   * tabs you opened with `page.close()`.
   */
  async close() {
    this.connection?.close();
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
    if (!this.connection) throw new Error("Call connect() before goto().");

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

export default Browser;
