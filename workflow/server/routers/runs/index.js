import { Router } from "express";
import * as db from "../../db.js";
import { broadcastWorkflows } from "../../socket.js";

// Mounted at /api/runs.
const runs = Router();

// Updates only the fields present in the body.
runs.patch("/:runId", async (req, res) => {
  const { runId } = req.params;
  const body = req.body ?? {};
  if (!["status", "error", "finishedAt"].some((key) => key in body)) {
    return res
      .status(400)
      .json({ error: "Send at least one of: status, error, finishedAt" });
  }
  const run = await db.updateRun(runId, body);
  if (!run) return res.status(404).json({ error: `Unknown run: ${runId}` });
  res.json(run);
  broadcastWorkflows().catch((error) => console.error(error));
});

// Creates the step on the first call and replaces it on later calls.
runs.put("/:runId/steps/:label", async (req, res) => {
  const { runId, label } = req.params;
  const body = req.body ?? {};
  if (!body.status) {
    return res.status(400).json({ error: "status is required" });
  }
  if (!(await db.getRun(runId))) {
    return res.status(404).json({ error: `Unknown run: ${runId}` });
  }
  res.json(await db.upsertStep(runId, label, body));
  broadcastWorkflows().catch((error) => console.error(error));
});

export default runs;
