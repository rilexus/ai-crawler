import { WebSocket, WebSocketServer } from "ws";
import { retryRun, startWorkflow } from "./apps.js";
import * as db from "./db.js";

// Messages are JSON objects with a `type`.
//
// Server to client:
// - { type: "workflows", workflows: [...] }: the full workflow list. Each
//   workflow has `runs`, its latest runs with their `steps`, newest first.
//   Sent on connect and after any workflow, run, or step changes.
// - { type: "start-result", requestId, workflowId, ok, error? }: the answer
//   to a `start` message.
// - { type: "retry-result", requestId, runId, ok, error? }: the answer to a
//   `retry` message.
// - { type: "delete-result", requestId, workflowId, ok, error? }: the answer
//   to a `delete` message.
// - { type: "delete-run-result", requestId, runId, ok, error? }: the answer
//   to a `delete-run` message.
//
// Client to server:
// - { type: "start", requestId, workflowId }: starts a new run of the
//   workflow. `requestId` is any value the client uses to match the answer.
// - { type: "retry", requestId, runId }: resumes a failed run.
// - { type: "delete", requestId, workflowId }: deletes the workflow with its
//   runs.
// - { type: "delete-run", requestId, runId }: deletes the run with its steps.
let wss = null;

// Deletes the workflow with its runs. Refuses while a run is running, since
// its app would keep reporting steps of a run that no longer exists.
async function deleteWorkflow(workflowId) {
  const runs = await db.listRuns(workflowId);
  if (runs.some(({ status }) => status === "running")) {
    throw new Error("Wait for the running run to finish, then delete.");
  }
  if (!(await db.deleteWorkflow(workflowId))) {
    throw new Error(`Unknown workflow: ${workflowId}`);
  }
  broadcastWorkflows().catch((error) => console.error(error));
}

// Deletes the run with its steps. Refuses while it's running, for the same
// reason as deleteWorkflow.
async function deleteRun(runId) {
  const run = await db.getRun(runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  if (run.status === "running") {
    throw new Error("Wait for the run to finish, then delete it.");
  }
  await db.deleteRun(runId);
  broadcastWorkflows().catch((error) => console.error(error));
}

// Client message types, with the function that handles each and the field
// that names its target.
const ACTIONS = {
  start: [startWorkflow, "workflowId"],
  retry: [retryRun, "runId"],
  delete: [deleteWorkflow, "workflowId"],
  "delete-run": [deleteRun, "runId"],
};

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

async function workflowsMessage() {
  return { type: "workflows", workflows: await db.listWorkflowsWithRuns() };
}

async function handleMessage(socket, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (!Object.hasOwn(ACTIONS, message.type)) return;
  const [action, field] = ACTIONS[message.type];
  const answer = {
    type: `${message.type}-result`,
    requestId: message.requestId,
    [field]: message[field],
  };
  try {
    await action(message[field]);
    send(socket, { ...answer, ok: true });
  } catch (error) {
    send(socket, { ...answer, ok: false, error: error.message });
  }
}

// Accepts WebSocket connections at /ws on the given HTTP server.
export function attachSocket(server) {
  wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      handleMessage(socket, raw).catch((error) => console.error(error));
    });
    workflowsMessage()
      .then((message) => send(socket, message))
      .catch((error) => console.error(error));
  });
}

// Sends the current workflow list to every connected client.
export async function broadcastWorkflows() {
  if (!wss?.clients.size) return;
  const message = await workflowsMessage();
  for (const socket of wss.clients) send(socket, message);
}
