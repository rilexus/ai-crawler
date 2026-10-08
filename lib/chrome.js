const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

/**
 * A connection to a Chrome browser over the Chrome DevTools Protocol.
 *
 * Commands go out with `send`; protocol events come back as `EventEmitter`
 * events named after the CDP method (for example, `Target.targetCreated`).
 * Every event listener receives `(params, sessionId)`.
 */
class CDPConnection extends EventEmitter {
  /**
   * @param {WebSocket} socket An open WebSocket to the browser endpoint.
   */
  constructor(socket) {
    super();
    this.socket = socket;
    this.nextId = 1;
    /** @type {Map<number, { resolve: Function, reject: Function, method: string }>} */
    this.pending = new Map();

    socket.addEventListener("message", (event) => this.#onMessage(event.data));
    socket.addEventListener("close", () => this.#onClose());
  }

  /**
   * Opens a WebSocket to a DevTools endpoint and wraps it in a connection.
   *
   * @param {string} webSocketDebuggerUrl The browser's `ws://` endpoint.
   * @returns {Promise<CDPConnection>}
   */
  static connect(webSocketDebuggerUrl) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(webSocketDebuggerUrl);
      socket.addEventListener(
        "open",
        () => resolve(new CDPConnection(socket)),
        {
          once: true,
        },
      );
      socket.addEventListener(
        "error",
        (event) =>
          reject(
            new Error(`Failed to connect to ${webSocketDebuggerUrl}`, {
              cause: event.error,
            }),
          ),
        { once: true },
      );
    });
  }

  /**
   * Sends a CDP command and resolves with its result.
   *
   * @param {string} method The CDP method, for example `Page.navigate`.
   * @param {object} [params] The command parameters.
   * @param {string} [sessionId] The target session to send the command to.
   *   Leave it out to address the browser itself.
   * @returns {Promise<any>}
   */
  send(method, params = {}, sessionId) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error(`Cannot send ${method}: connection is closed.`),
      );
    }

    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify(message));
    });
  }

  /**
   * Closes the WebSocket. Pending commands reject.
   */
  close() {
    this.socket.close();
  }

  #onMessage(data) {
    const message = JSON.parse(data);

    if (message.id === undefined) {
      this.emit(message.method, message.params, message.sessionId);
      return;
    }

    const callback = this.pending.get(message.id);
    if (!callback) return;
    this.pending.delete(message.id);

    if (message.error) {
      callback.reject(
        new Error(`${callback.method} failed: ${message.error.message}`),
      );
    } else {
      callback.resolve(message.result);
    }
  }

  #onClose() {
    for (const { reject, method } of this.pending.values()) {
      reject(new Error(`${method} failed: connection closed.`));
    }
    this.pending.clear();
    this.emit("disconnected");
  }
}

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

/**
 * Launches Chrome with remote debugging on and connects to it over CDP.
 *
 * @param {object} [options]
 * @param {string} [options.executablePath] The browser binary. Defaults to
 *   `CHROME_PATH`, then Brave.
 * @param {boolean} [options.headless=true] Whether to run without a window.
 * @param {string[]} [options.args] Extra Chrome command-line flags.
 * @param {number} [options.timeout=30000] Milliseconds to wait for startup.
 * @param {string} [options.userDataDir] A profile directory to reuse, such as
 *   one from `copyBraveProfile`. `close` keeps it. Without it, the browser
 *   gets a temporary profile that `close` deletes.
 * @returns {Promise<{ connection: CDPConnection, close: () => Promise<void> }>}
 */
async function launchChrome({
  executablePath,
  headless = true,
  args = [],
  timeout = 30_000,
  userDataDir: persistentUserDataDir,
} = {}) {
  const userDataDir =
    persistentUserDataDir ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "ai-crawler-chrome-")));

  const child = spawn(
    executablePath ?? defaultExecutablePath(),
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...(headless ? ["--headless=new"] : []),
      ...args,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let connection;
  const close = async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      // Ask the browser to quit so it saves cookies and removes its profile
      // lock. Kill it only if it doesn't exit in time.
      await connection?.send("Browser.close").catch(() => {});
      const timer = setTimeout(() => child.kill(), 5_000);
      if (!connection) child.kill();
      await exited;
      clearTimeout(timer);
    }
    connection?.close();
    if (!persistentUserDataDir) {
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
  };

  try {
    const endpoint = await waitForEndpoint(child, timeout);
    connection = await CDPConnection.connect(endpoint);
  } catch (error) {
    await close();
    throw error;
  }

  return { connection, close };
}

/**
 * Connects to a Chrome instance that already runs with
 * `--remote-debugging-port`.
 *
 * @param {string} [host="http://127.0.0.1:9222"] The debugging HTTP address.
 * @returns {Promise<CDPConnection>}
 */
async function connectToChrome(host = "http://127.0.0.1:9222") {
  const response = await fetch(`${host}/json/version`);
  if (!response.ok) {
    throw new Error(`Chrome at ${host} answered ${response.status}.`);
  }
  const { webSocketDebuggerUrl } = await response.json();
  return CDPConnection.connect(webSocketDebuggerUrl);
}

const BRAVE_USER_DATA_DIR = path.join(
  os.homedir(),
  "Library/Application Support/BraveSoftware/Brave-Browser",
);

/**
 * Connects to the Brave window you already have open, with your own profile.
 *
 * Brave doesn't accept `--remote-debugging-port` for the default profile, so
 * turn on remote debugging inside the running browser instead: open
 * `brave://inspect/#remote-debugging` and allow it. Brave then writes the
 * DevTools address to `DevToolsActivePort` in its user data directory and
 * asks you to approve each new connection.
 *
 * @param {string} [userDataDir] Brave's user data directory.
 * @returns {Promise<CDPConnection>}
 */
async function connectToRunningBrave(userDataDir = BRAVE_USER_DATA_DIR) {
  let activePort;
  try {
    activePort = await fs.readFile(
      path.join(userDataDir, "DevToolsActivePort"),
      "utf8",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(
      "Brave isn't open or doesn't allow remote debugging. Open Brave, go to brave://inspect/#remote-debugging, and allow remote debugging.",
    );
  }

  // The file holds the port on the first line and the browser path on the
  // second. Brave leaves it behind on exit, so a refused connection means
  // the browser is closed.
  const [port, browserPath] = activePort.trim().split("\n");
  try {
    return await CDPConnection.connect(`ws://127.0.0.1:${port}${browserPath}`);
  } catch (error) {
    throw new Error(
      `Couldn't connect to Brave on port ${port}. Make sure Brave is open and you approved the connection.`,
      { cause: error },
    );
  }
}

// Folders the browser rebuilds on its own. Skipping them keeps the copy small.
const SKIPPED_PROFILE_DIRS = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
  "CacheStorage",
  "ScriptCache",
]);

/**
 * Checks whether a browser runs from `userDataDir`. The browser keeps a
 * `SingletonLock` symlink pointing to `<hostname>-<pid>`, but a browser that
 * was killed leaves it behind, so check that the process is still alive.
 *
 * @param {string} userDataDir
 * @returns {Promise<boolean>}
 */
async function isBrowserRunning(userDataDir) {
  let target;
  try {
    target = await fs.readlink(path.join(userDataDir, "SingletonLock"));
  } catch (error) {
    // No lock, or not a symlink. Anything else, such as macOS refusing
    // access, means we can't tell.
    if (error.code === "ENOENT" || error.code === "EINVAL") return false;
    throw error;
  }

  const pid = Number(target.slice(target.lastIndexOf("-") + 1));
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error.code === "EPERM";
  }
}

/**
 * Copies a Brave profile, including its cookies and logins, into a
 * directory that `launchChrome({ userDataDir })` can start Brave from.
 *
 * The copy is a snapshot: logins made later in either browser don't carry
 * over. Quit Brave first, because copying a profile in use can catch its
 * databases mid-write. Replaces anything already at `destination`.
 *
 * @param {string} destination The directory to create.
 * @param {object} [options]
 * @param {string} [options.source] Brave's user data directory.
 * @param {string} [options.profile="Default"] The profile folder to copy.
 *   Other profiles are named `Profile 1`, `Profile 2`, and so on. Start
 *   Brave with `--profile-directory=<profile>` so it opens this profile and
 *   not the last one you used.
 * @returns {Promise<string>} `destination`, ready to pass as `userDataDir`.
 */
async function copyBraveProfile(
  destination,
  { source = BRAVE_USER_DATA_DIR, profile = "Default" } = {},
) {
  // Check access before touching `destination`, so a failure keeps the
  // previous copy.
  try {
    await fs.readdir(path.join(source, profile));
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    throw new Error(
      `macOS doesn't allow this app to read ${source}. Open System Settings > Privacy & Security > Full Disk Access, turn it on for the app you run Node from (such as Visual Studio Code or Terminal), then restart that app.`,
      { cause: error },
    );
  }

  if (await isBrowserRunning(source)) {
    throw new Error("Quit Brave before copying its profile.");
  }
  // Replacing a profile under a running browser corrupts it.
  if (await isBrowserRunning(destination)) {
    throw new Error(
      `Close the browser that uses ${destination} before copying over it.`,
    );
  }

  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  await fs.copyFile(
    path.join(source, "Local State"),
    path.join(destination, "Local State"),
  );
  await fs.cp(path.join(source, profile), path.join(destination, profile), {
    recursive: true,
    filter: (file) => !SKIPPED_PROFILE_DIRS.has(path.basename(file)),
  });

  return destination;
}

module.exports = {
  copyBraveProfile,
  CDPConnection,
  launchChrome,
  connectToChrome,
  connectToRunningBrave,
};
