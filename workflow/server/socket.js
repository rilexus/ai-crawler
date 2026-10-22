import { WebSocket, WebSocketServer } from "ws";
import { startWorkflow } from "./apps.js";
import * as db from "./db.js";

// Messages are JSON objects with a `type`.
//
// Server to client:
// - { type: "workflows", workflows: [...] }: the full workflow list. Each
//   workflow has `lastRun`, its latest run with `steps`, or null. Sent on
//   connect and after any workflow, run, or step changes.
// - { type: "start-result", requestId, workflowId, ok, error? }: the answer
//   to a `start` message.
//
// Client to server:
// - { type: "start", requestId, workflowId }: starts a run of the workflow.
//   `requestId` is any value the client uses to match the answer.
let wss = null;

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

async function workflowsMessage() {
  return { type: "workflows", workflows: await db.listWorkflowsWithLastRun() };
}

async function handleMessage(socket, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message.type === "start") {
    const { requestId, workflowId } = message;
    try {
      await startWorkflow(workflowId);
      send(socket, { type: "start-result", requestId, workflowId, ok: true });
    } catch (error) {
      send(socket, {
        type: "start-result",
        requestId,
        workflowId,
        ok: false,
        error: error.message,
      });
    }
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
