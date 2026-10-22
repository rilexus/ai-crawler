import { Router } from "express";
import * as db from "../../db.js";
import { broadcastWorkflows } from "../../socket.js";

// Mounted at /api/workflows. The UI reads workflows over the WebSocket in
// socket.js, so this router only has the writes that lib/workflow.js makes.
const workflows = Router();

// Returns 404 unless the workflow in the URL exists.
async function requireWorkflow(req, res, next) {
  const { workflowId } = req.params;
  if (!(await db.getWorkflow(workflowId))) {
    return res.status(404).json({ error: `Unknown workflow: ${workflowId}` });
  }
  next();
}

// Creates the workflow, or replaces its app, triggers, step labels, and URL
// if it exists.
workflows.put("/:workflowId", async (req, res) => {
  const { workflow, changed } = await db.upsertWorkflow(
    req.params.workflowId,
    req.body ?? {},
  );
  res.json(workflow);
  if (changed) broadcastWorkflows().catch((error) => console.error(error));
});

// Starts a run of the workflow and returns it with its ID.
workflows.post("/:workflowId/runs", requireWorkflow, async (req, res) => {
  const run = await db.createRun(req.params.workflowId, req.body ?? {});
  res.status(201).json(run);
  broadcastWorkflows().catch((error) => console.error(error));
});

export default workflows;
