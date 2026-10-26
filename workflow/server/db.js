import sqlite3 from "sqlite3";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const DB_PATH =
  process.env.DB_PATH ||
  fileURLToPath(new URL("../workflows.sqlite", import.meta.url));

const db = new sqlite3.Database(DB_PATH);

// Promise wrappers around the callback-based sqlite3 API.
const run = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    }),
  );
const get = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))),
  );
const all = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))),
  );

const toJSON = (value) => (value == null ? null : JSON.stringify(value));
const fromJSON = (text) => (text == null ? null : JSON.parse(text));

await run("PRAGMA foreign_keys = ON");
await run(`
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    app_id TEXT,
    triggers TEXT,
    url TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);
// Databases created before the url column existed.
const workflowColumns = await all("PRAGMA table_info(workflows)");
if (!workflowColumns.some(({ name }) => name === "url")) {
  await run("ALTER TABLE workflows ADD COLUMN url TEXT");
}
// Databases created before the steps column existed.
if (!workflowColumns.some(({ name }) => name === "steps")) {
  await run("ALTER TABLE workflows ADD COLUMN steps TEXT");
}
await run(`
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id),
    event TEXT,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  )
`);
// Databases created before the result column existed.
const runColumns = await all("PRAGMA table_info(runs)");
if (!runColumns.some(({ name }) => name === "result")) {
  await run("ALTER TABLE runs ADD COLUMN result TEXT");
}
await run(`
  CREATE TABLE IF NOT EXISTS steps (
    run_id TEXT NOT NULL REFERENCES runs(id),
    label TEXT NOT NULL,
    position INTEGER NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    PRIMARY KEY (run_id, label)
  )
`);

const formatWorkflow = (row) =>
  row && {
    id: row.id,
    appId: row.app_id,
    triggers: fromJSON(row.triggers),
    steps: fromJSON(row.steps) ?? [],
    url: row.url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
const formatRun = (row) =>
  row && {
    id: row.id,
    workflowId: row.workflow_id,
    event: fromJSON(row.event),
    status: row.status,
    result: fromJSON(row.result),
    error: fromJSON(row.error),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
const formatStep = (row) =>
  row && {
    label: row.label,
    status: row.status,
    result: fromJSON(row.result),
    error: fromJSON(row.error),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };

// Functions that look up one record return undefined when it doesn't exist.

export async function listWorkflows() {
  const rows = await all("SELECT * FROM workflows ORDER BY id");
  return rows.map(formatWorkflow);
}

// Returns every workflow with its latest `runsPerWorkflow` runs in `runs`,
// newest first, each with its steps.
export async function listWorkflowsWithRuns({ runsPerWorkflow = 10 } = {}) {
  const workflows = await listWorkflows();
  return Promise.all(
    workflows.map(async (workflow) => {
      const rows = await all(
        `SELECT id FROM runs WHERE workflow_id = ?
         ORDER BY started_at DESC LIMIT ?`,
        [workflow.id, runsPerWorkflow],
      );
      const runs = await Promise.all(rows.map(({ id }) => getRunWithSteps(id)));
      return { ...workflow, runs };
    }),
  );
}

export async function getWorkflow(id) {
  return formatWorkflow(
    await get("SELECT * FROM workflows WHERE id = ?", [id]),
  );
}

// Creates the workflow, or replaces its app, triggers, step labels, and URL
// if it exists. Returns the workflow and whether anything changed; a repeated
// sync with the same values changes nothing, not even updatedAt.
export async function upsertWorkflow(
  id,
  { appId = null, triggers = {}, steps = [], url = null },
) {
  const now = Date.now();
  const { changes } = await run(
    `INSERT INTO workflows
       (id, app_id, triggers, steps, url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       app_id = excluded.app_id,
       triggers = excluded.triggers,
       steps = excluded.steps,
       url = excluded.url,
       updated_at = excluded.updated_at
     WHERE app_id IS NOT excluded.app_id
        OR triggers IS NOT excluded.triggers
        OR steps IS NOT excluded.steps
        OR url IS NOT excluded.url`,
    [id, appId, toJSON(triggers), toJSON(steps), url, now, now],
  );
  return { workflow: await getWorkflow(id), changed: changes > 0 };
}

// Deletes the workflow with its runs and their steps. Returns whether the
// workflow existed.
export async function deleteWorkflow(id) {
  await run("BEGIN");
  try {
    await run(
      `DELETE FROM steps
       WHERE run_id IN (SELECT id FROM runs WHERE workflow_id = ?)`,
      [id],
    );
    await run("DELETE FROM runs WHERE workflow_id = ?", [id]);
    const { changes } = await run("DELETE FROM workflows WHERE id = ?", [id]);
    await run("COMMIT");
    return changes > 0;
  } catch (error) {
    await run("ROLLBACK");
    throw error;
  }
}

// Deletes the run with its steps. Returns whether the run existed.
export async function deleteRun(id) {
  await run("BEGIN");
  try {
    await run("DELETE FROM steps WHERE run_id = ?", [id]);
    const { changes } = await run("DELETE FROM runs WHERE id = ?", [id]);
    await run("COMMIT");
    return changes > 0;
  } catch (error) {
    await run("ROLLBACK");
    throw error;
  }
}

// Returns the distinct app URLs that workflows registered.
export async function listAppUrls() {
  const rows = await all(
    "SELECT DISTINCT url FROM workflows WHERE url IS NOT NULL",
  );
  return rows.map(({ url }) => url);
}

export async function listRuns(workflowId) {
  const rows = await all(
    "SELECT * FROM runs WHERE workflow_id = ? ORDER BY started_at DESC",
    [workflowId],
  );
  return rows.map(formatRun);
}

export async function getRun(id) {
  return formatRun(await get("SELECT * FROM runs WHERE id = ?", [id]));
}

// Returns the run with its steps in the order they first ran.
export async function getRunWithSteps(id) {
  const record = await getRun(id);
  if (!record) return undefined;
  const steps = await all(
    "SELECT * FROM steps WHERE run_id = ? ORDER BY position",
    [id],
  );
  return { ...record, steps: steps.map(formatStep) };
}

export async function createRun(workflowId, { event = null }) {
  const id = randomUUID();
  await run(
    `INSERT INTO runs (id, workflow_id, event, status, started_at)
     VALUES (?, ?, ?, 'running', ?)`,
    [id, workflowId, toJSON(event), Date.now()],
  );
  return getRun(id);
}

// Updates only the fields present in `fields`. Returns undefined if the run
// doesn't exist.
export async function updateRun(id, fields) {
  const columns = {
    status: ["status", fields.status],
    result: ["result", toJSON(fields.result)],
    error: ["error", toJSON(fields.error)],
    finishedAt: ["finished_at", fields.finishedAt],
  };
  const updates = Object.entries(columns).filter(([key]) => key in fields);
  if (!updates.length) throw new Error("No fields to update");

  const { changes } = await run(
    `UPDATE runs SET ${updates.map(([, [column]]) => `${column} = ?`).join(", ")}
     WHERE id = ?`,
    [...updates.map(([, [, value]]) => value), id],
  );
  return changes ? getRun(id) : undefined;
}

// Creates the step on the first call and replaces it on later calls. The
// step keeps the position it got on creation.
export async function upsertStep(
  runId,
  label,
  { status, result = null, error = null, startedAt = null, finishedAt = null },
) {
  await run(
    `INSERT INTO steps
       (run_id, label, position, status, result, error, started_at, finished_at)
     VALUES (
       ?, ?, (SELECT COUNT(*) FROM steps WHERE run_id = ?), ?, ?, ?, ?, ?
     )
     ON CONFLICT(run_id, label) DO UPDATE SET
       status = excluded.status,
       result = excluded.result,
       error = excluded.error,
       started_at = excluded.started_at,
       finished_at = excluded.finished_at`,
    [
      runId,
      label,
      runId,
      status,
      toJSON(result),
      toJSON(error),
      startedAt,
      finishedAt,
    ],
  );
  return formatStep(
    await get("SELECT * FROM steps WHERE run_id = ? AND label = ?", [
      runId,
      label,
    ]),
  );
}
