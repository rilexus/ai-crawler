import * as db from "./db.js";

// Apps to sync even before any of them registered a URL. Each URL is where
// the app mounted `workflow.serve()`.
const KNOWN_APP_URLS = (
  process.env.WORKFLOW_APP_URLS ?? "http://localhost:3001/api/workflow"
)
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

// Syncing again picks up apps that started late, restarted, or added
// workflows. A sync with no changes doesn't touch the database.
const SYNC_INTERVAL = 5_000;
const REQUEST_TIMEOUT = 5_000;

// Whether the last sync of each URL worked, so a log line appears only when
// that changes.
const reachable = new Map();

async function request(url, options) {
  try {
    return await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
  } catch {
    throw new Error(`Can't reach the app at ${url}.`);
  }
}

// Asks the app at `url` to register its workflows. The app takes its URL
// from this request.
async function syncApp(url) {
  try {
    const res = await request(url, { method: "PUT" });
    if (!res.ok) throw new Error(`The app responded with HTTP ${res.status}.`);
    if (reachable.get(url) !== true) console.log(`Synced app at ${url}`);
    reachable.set(url, true);
  } catch (error) {
    if (reachable.get(url) !== false) {
      console.warn(`Can't sync app at ${url}: ${error.message}`);
    }
    reachable.set(url, false);
  }
}

export async function syncApps() {
  const urls = new Set([...KNOWN_APP_URLS, ...(await db.listAppUrls())]);
  await Promise.all([...urls].map(syncApp));
}

export function startSyncing() {
  const sync = () => syncApps().catch((error) => console.error(error));
  sync();
  setInterval(sync, SYNC_INTERVAL).unref();
}

// Sends the workflow's trigger event to its app, which starts a run. Throws
// with a message for the UI if the workflow can't start.
export async function startWorkflow(workflowId) {
  const workflow = await db.getWorkflow(workflowId);
  if (!workflow) throw new Error(`Unknown workflow: ${workflowId}`);
  if (!workflow.url) throw new Error("The workflow's app hasn't synced yet.");
  const type = workflow.triggers?.event?.type;
  if (!type) throw new Error("The workflow has no event trigger.");

  const res = await request(workflow.url, {
    method: "POST",
    body: JSON.stringify({ type, data: null, workflowId }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      body?.error ?? `The app responded with HTTP ${res.status}.`,
    );
  }
  return body;
}
