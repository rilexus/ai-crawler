import express, { Router } from "express";

const API_URL = process.env.API_URL || "http://localhost:3000";

class Workflow {
  constructor({ id } = {}) {
    this.id = id;
    this.workflows = new Map();
  }

  // Reports to the API server. A failed call logs a warning and returns null,
  // so an unreachable server doesn't stop the workflow.
  async #api(method, path, body) {
    try {
      const res = await fetch(`${API_URL}/api${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      return data;
    } catch (e) {
      console.warn(`${method} ${path} failed: ${e.message}`);
      return null;
    }
  }

  static #serializeError(error) {
    return error ? { message: error.message, stack: error.stack } : null;
  }

  #saveStep(runId, entry) {
    if (!runId) return;
    const { label, status, returnedValue, error, startedAt, finishedAt } =
      entry;
    return this.#api(
      "PUT",
      `/runs/${runId}/steps/${encodeURIComponent(label)}`,
      {
        status,
        result: status === "finished" ? (returnedValue ?? null) : null,
        error: Workflow.#serializeError(error),
        startedAt: startedAt ?? null,
        finishedAt: finishedAt ?? null,
      },
    );
  }

  #get(id) {
    const workflow = this.workflows.get(id);
    if (!workflow) throw new Error(`Unknown workflow: ${id}`);
    return workflow;
  }

  getErrored({ id }) {
    return this.#get(id)
      .steps.filter(({ status }) => status === "error")
      .map(({ label }) => label);
  }

  getStatus({ id }) {
    const { status, error, steps } = this.#get(id);
    return {
      id,
      status,
      error: error?.message,
      steps: steps.map(({ label, status, error, startedAt, finishedAt }) => ({
        label,
        status,
        error: error?.message,
        startedAt,
        finishedAt,
      })),
    };
  }

  async #step(workflow, runId, label, callback) {
    let entry = workflow.steps.find((s) => s.label === label);

    // A finished step from an earlier run returns its saved value. Record it
    // in this run too, so the run shows every step.
    if (entry?.status === "finished") {
      await this.#saveStep(runId, entry);
      return entry.returnedValue;
    }
    if (!entry) {
      entry = { label };
      workflow.steps.push(entry);
    }
    // A previous step failed, so record this one without running it.
    if (this.getErrored(workflow).length) {
      Object.assign(entry, {
        callback,
        status: "skipped",
        startedAt: undefined,
        finishedAt: undefined,
      });
      await this.#saveStep(runId, entry);
      return;
    }

    Object.assign(entry, {
      callback,
      status: "running",
      startedAt: Date.now(),
      finishedAt: undefined,
      error: null,
    });
    await this.#saveStep(runId, entry);

    try {
      const result = await callback();
      Object.assign(entry, {
        status: "finished",
        finishedAt: Date.now(),
        returnedValue: result,
      });
      await this.#saveStep(runId, entry);
      return result;
    } catch (e) {
      Object.assign(entry, {
        status: "error",
        finishedAt: Date.now(),
        error: e,
        returnedValue: null,
      });
      await this.#saveStep(runId, entry);
    }
  }

  // Returns the IDs of the workflows whose trigger matches the event's type.
  match({ event }) {
    return [...this.workflows.values()]
      .filter(({ triggers }) => triggers.event?.type === event.type)
      .map(({ id }) => id);
  }

  // Runs every workflow whose trigger matches the event's type.
  async send({ event }) {
    return Promise.all(
      this.match({ event }).map((id) => this.run({ id, event })),
    );
  }

  // Registers every workflow and its step labels with the workflow server,
  // along with the URL where `serve()` is mounted, so the server can start
  // them.
  async #register(url) {
    await Promise.all(
      [...this.workflows.values()].map(({ id, triggers, steps }) =>
        this.#api("PUT", `/workflows/${encodeURIComponent(id)}`, {
          appId: this.id,
          triggers,
          steps: steps.map(({ label }) => label),
          url,
        }),
      ),
    );
  }

  // Returns a router to mount in the app, for example
  // `app.use("/api/workflow", workflow.serve())`. The app doesn't need to
  // know its own URL: the workflow server calls PUT to sync, and the router
  // registers the URL that request reached.
  //
  // - PUT: registers every workflow with this router's URL.
  // - POST { type, data, workflowId? }: starts the workflows that the event
  //   triggers, or only `workflowId` if given. Responds 202 with their IDs
  //   before the runs finish.
  //
  // When the request URL isn't the one the workflow server should call, for
  // example behind a proxy or in containers, override its parts:
  // - `serveHost` or WORKFLOW_SERVE_HOST: protocol and host, such as
  //   "https://myapp.com". Replaces the request's protocol and Host header.
  // - `servePath` or WORKFLOW_SERVE_PATH: path, such as "/api/workflow".
  //   Replaces the path the router is mounted at.
  // An option takes precedence over its environment variable.
  serve({
    serveHost = process.env.WORKFLOW_SERVE_HOST,
    servePath = process.env.WORKFLOW_SERVE_PATH,
  } = {}) {
    const router = Router();
    router.use(express.json());

    router.put("/", async (req, res) => {
      const host = serveHost || `${req.protocol}://${req.get("host")}`;
      const path = servePath || req.baseUrl;
      const url = `${host.replace(/\/+$/, "")}${path}`;
      await this.#register(url);
      res.json({ url, workflows: [...this.workflows.keys()] });
    });

    router.post("/", (req, res) => {
      const { type, data = null, workflowId } = req.body ?? {};
      if (typeof type !== "string" || !type) {
        return res
          .status(400)
          .json({ error: "type is required and must be a string" });
      }
      const event = { type, data };
      const ids = this.match({ event }).filter(
        (id) => workflowId === undefined || id === workflowId,
      );
      if (workflowId !== undefined && !ids.length) {
        return res.status(404).json({
          error: `No workflow ${workflowId} is triggered by ${type}`,
        });
      }

      // Runs in the background, so the response doesn't wait for the runs.
      Promise.all(ids.map((id) => this.run({ id, event })))
        .then((statuses) => console.dir(statuses, { depth: null }))
        .catch((error) => console.error(error));

      res.status(202).json({ event, workflows: ids });
    });

    return router;
  }

  // Calls the workflow's callback with a `step` that records each label
  // without running the step, and returns the labels in order. Each step
  // returns undefined, so code that uses a step's value can throw; the labels
  // found before the error are kept.
  static async #discoverSteps(callback) {
    const labels = [];
    try {
      await callback({
        event: null,
        step: async (label) => {
          if (!labels.includes(label)) labels.push(label);
        },
      });
    } catch {
      // Steps after the error are added when a run reaches them.
    }
    return labels;
  }

  // Registers the workflow and its steps in the "init" state. No step runs
  // until `run()`, but code outside steps runs once here.
  async create({ id, triggers = {} }, callback) {
    const labels = await Workflow.#discoverSteps(callback);
    this.workflows.set(id, {
      id,
      callback,
      triggers,
      status: "pending",
      error: null,
      steps: labels.map((label) => ({ label, status: "init" })),
    });
  }

  async run({ id, event }) {
    const workflow = this.#get(id);
    workflow.status = "running";
    workflow.error = null;

    const created = await this.#api(
      "POST",
      `/workflows/${encodeURIComponent(id)}/runs`,
      { event: event ?? null },
    );
    const runId = created?.id;

    try {
      await workflow.callback({
        event,
        step: (label, callback) => this.#step(workflow, runId, label, callback),
      });
      workflow.status = this.getErrored(workflow).length ? "error" : "finished";
    } catch (e) {
      workflow.status = "error";
      workflow.error = e;
    }

    if (runId) {
      await this.#api("PATCH", `/runs/${runId}`, {
        status: workflow.status,
        error: Workflow.#serializeError(workflow.error),
        finishedAt: Date.now(),
      });
    }

    return { ...this.getStatus(workflow), runId };
  }
}

export default Workflow;
