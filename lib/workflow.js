import express, { Router } from "express";

const API_URL = process.env.API_URL || "http://localhost:3000";

// A workflow is a template: its ID, triggers, callback, and step labels. Each
// `run()` creates a run of it, with its own event and step state, so several
// runs of one workflow can run at the same time.
class Workflow {
  constructor({ id } = {}) {
    this.id = id;
    // Workflow templates by ID.
    this.workflows = new Map();
    // Runs in progress by run ID. A run gets an ID from the workflow server,
    // so runs that the server didn't record aren't here.
    this.runs = new Map();
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

  static #failed(run) {
    return run.steps.some(({ status }) => status === "error");
  }

  #saveStep(run, entry) {
    if (!run.id) return;
    const { label, status, returnedValue, error, startedAt, finishedAt } =
      entry;
    return this.#api(
      "PUT",
      `/runs/${run.id}/steps/${encodeURIComponent(label)}`,
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

  static #status(run) {
    return {
      runId: run.id,
      workflowId: run.workflow.id,
      status: run.status,
      result: run.result,
      error: run.error?.message,
      steps: run.steps.map(
        ({ label, status, error, startedAt, finishedAt }) => ({
          label,
          status,
          error: error?.message,
          startedAt,
          finishedAt,
        }),
      ),
    };
  }

  async #step(run, label, callback) {
    let entry = run.steps.find((s) => s.label === label);

    // A step that finished before a retry, or earlier in this run under the
    // same label, returns its saved value without running again.
    if (entry?.status === "finished") return entry.returnedValue;
    if (!entry) {
      entry = { label };
      run.steps.push(entry);
    }
    // The template lists every label a run reached, including labels that
    // `create()` didn't find.
    if (!run.workflow.labels.includes(label)) run.workflow.labels.push(label);

    // A previous step failed, so record this one without running it.
    if (Workflow.#failed(run)) {
      Object.assign(entry, {
        status: "skipped",
        startedAt: undefined,
        finishedAt: undefined,
      });
      await this.#saveStep(run, entry);
      return;
    }

    Object.assign(entry, {
      status: "running",
      startedAt: Date.now(),
      finishedAt: undefined,
      error: null,
    });
    await this.#saveStep(run, entry);

    try {
      const result = await callback();
      Object.assign(entry, {
        status: "finished",
        finishedAt: Date.now(),
        returnedValue: result,
      });
      await this.#saveStep(run, entry);
      return result;
    } catch (e) {
      Object.assign(entry, {
        status: "error",
        finishedAt: Date.now(),
        error: e,
        returnedValue: null,
      });
      await this.#saveStep(run, entry);
    }
  }

  // Returns the IDs of the workflows whose trigger matches the event's type.
  match({ event }) {
    return [...this.workflows.values()]
      .filter(({ triggers }) => triggers.event?.type === event.type)
      .map(({ id }) => id);
  }

  // Starts a run of every workflow whose trigger matches the event's type.
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
      [...this.workflows.values()].map(({ id, triggers, labels }) =>
        this.#api("PUT", `/workflows/${encodeURIComponent(id)}`, {
          appId: this.id,
          triggers,
          steps: labels,
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
  // - PUT /: registers every workflow with this router's URL.
  // - POST / { type, data, workflowId? }: starts a run of each workflow that
  //   the event triggers, or only of `workflowId` if given. Responds 202 with
  //   the workflow IDs before the runs finish.
  // - POST /runs/:runId/retry { workflowId, event, steps }: resumes a failed
  //   run. `steps` lists the run's steps with their status and result; the
  //   finished ones return their result instead of running again. Responds
  //   202 before the run finishes.
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

    // Logs a run that the router started in the background.
    const report = (promise) =>
      promise
        .then((statuses) => console.dir(statuses, { depth: null }))
        .catch((error) => console.error(error));

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

      report(Promise.all(ids.map((id) => this.run({ id, event }))));
      res.status(202).json({ event, workflows: ids });
    });

    router.post("/runs/:runId/retry", (req, res) => {
      const { runId } = req.params;
      const { workflowId, event = null, steps = [] } = req.body ?? {};
      if (!this.workflows.has(workflowId)) {
        return res
          .status(404)
          .json({ error: `Unknown workflow: ${workflowId}` });
      }
      if (this.runs.has(runId)) {
        return res.status(409).json({ error: "The run is already running." });
      }

      report(this.retry({ runId, workflowId, event, steps }));
      res.status(202).json({ runId });
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

  // Registers the workflow template and its step labels. No step runs until
  // `run()`, but code outside steps runs once here.
  async create({ id, triggers = {} }, callback) {
    const labels = await Workflow.#discoverSteps(callback);
    this.workflows.set(id, { id, callback, triggers, labels });
  }

  // Starts a new run of the workflow and returns its status when it ends.
  async run({ id, event = null }) {
    const workflow = this.#get(id);
    const created = await this.#api(
      "POST",
      `/workflows/${encodeURIComponent(id)}/runs`,
      { event },
    );
    return this.#execute({ id: created?.id, workflow, event, steps: [] });
  }

  // Resumes a failed run under the same run ID. Finished steps from `steps`
  // return their saved result; the step that failed and the steps after it
  // run again. Returns the run's status when it ends.
  async retry({ runId, workflowId, event = null, steps = [] }) {
    const run = {
      id: runId,
      workflow: this.#get(workflowId),
      event,
      steps: steps
        .filter(({ status }) => status === "finished")
        .map(({ label, result }) => ({
          label,
          status: "finished",
          returnedValue: result,
        })),
    };
    if (this.runs.has(runId)) throw new Error(`Run ${runId} is running`);
    // Set before the first await, so a second retry of this run is refused.
    this.runs.set(runId, run);
    await this.#api("PATCH", `/runs/${runId}`, {
      status: "running",
      result: null,
      error: null,
      finishedAt: null,
    });
    return this.#execute(run);
  }

  async #execute(run) {
    Object.assign(run, { status: "running", result: null, error: null });
    if (run.id) this.runs.set(run.id, run);

    try {
      const result = await run.workflow.callback({
        event: run.event,
        step: (label, callback) => this.#step(run, label, callback),
      });
      run.status = Workflow.#failed(run) ? "error" : "finished";
      if (run.status === "finished") run.result = result ?? null;
    } catch (e) {
      run.status = "error";
      run.error = e;
    }

    if (run.id) {
      await this.#api("PATCH", `/runs/${run.id}`, {
        status: run.status,
        result: run.result,
        error: Workflow.#serializeError(run.error),
        finishedAt: Date.now(),
      });
      this.runs.delete(run.id);
    }

    return Workflow.#status(run);
  }
}

export default Workflow;
