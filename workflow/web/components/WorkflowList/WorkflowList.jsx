import { useEffect, useRef, useState } from "react";
import {
  Actions,
  BackButton,
  Banner,
  Button,
  COMPACT_QUERY,
  Confirmation,
  DestructiveButton,
  Details,
  ErrorMessage,
  ErrorText,
  List,
  Meta,
  Name,
  Pane,
  PaneHeading,
  Panes,
  Placeholder,
  Row,
  RowStatus,
  RunHeader,
  Section,
  SelectButton,
  Step,
  StepError,
  StepFailure,
  StepResult,
  Steps,
  StepStatus,
} from "./styles";
import useSelection from "./useSelection";
import useWorkflows from "./useWorkflows";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const STATUS_LABELS = {
  init: "Pending",
  running: "Running",
  finished: "Finished",
  error: "Failed",
  skipped: "Skipped",
};

const statusLabel = (status) => STATUS_LABELS[status] ?? status;

// Panes from parent to child. In a narrow window, a pane earlier in this list
// than the one before it means the person went back.
const PANE_ORDER = ["workflows", "runs", "steps"];

function WarningIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M10 2 1 18h18L10 2Zm0 5v5m0 2.5v.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);

  useEffect(() => {
    const list = matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);

  return matches;
}

function Time({ value }) {
  return (
    <time dateTime={new Date(value).toISOString()}>
      {dateFormat.format(value)}
    </time>
  );
}

// Returns the workflow's step labels with their status in the run, followed
// by steps the run reached that the workflow didn't list. Steps the run
// hasn't reached yet are "init".
function stepsWithStatus(labels, run) {
  const runSteps = new Map(run.steps.map((step) => [step.label, step]));
  return [...new Set([...labels, ...runSteps.keys()])].map((label) => ({
    label,
    status: runSteps.get(label)?.status ?? "init",
    result: runSteps.get(label)?.result ?? null,
    error: runSteps.get(label)?.error?.message,
  }));
}

// "Step 3 of 5" for a running run, or null.
function progress(labels, run) {
  if (run.status !== "running") return null;
  const steps = stepsWithStatus(labels, run);
  if (!steps.length) return null;
  const done = steps.filter(
    ({ status }) => status === "finished" || status === "skipped",
  ).length;
  return `Step ${Math.min(done + 1, steps.length)} of ${steps.length}`;
}

// The steps of the selected run, with their results and errors. A run the
// server no longer lists among the latest runs is `stale`: it shows its last
// known state.
function RunDetail({ workflowId, labels, run, stale, canRetry, retry }) {
  const steps = stepsWithStatus(labels, run);
  // null, or { status: "retrying" | "error", message? }
  const [retryState, setRetryState] = useState(null);
  const failed = run.status === "error";

  // The run's new status ends the retry, so the button stays busy until the
  // run is running again.
  useEffect(() => setRetryState(null), [run.status]);

  const handleRetry = () => {
    setRetryState({ status: "retrying" });
    retry(run.id).catch((error) =>
      setRetryState({ status: "error", message: error.message }),
    );
  };

  const retryButton = failed && (
    <Button
      type="button"
      onClick={handleRetry}
      disabled={!canRetry || retryState?.status === "retrying"}
      aria-label={`Retry the run of ${workflowId} started ${dateFormat.format(run.startedAt)}`}
    >
      {retryState?.status === "retrying" ? "Retrying…" : "Retry"}
    </Button>
  );
  // A run can fail outside a step, when its callback throws.
  const failedStep = steps.some(({ error }) => error);
  const runProgress = progress(labels, run);

  return (
    <div>
      <RunHeader>
        <Meta>
          {workflowId} · Started <Time value={run.startedAt} />
          {runProgress && ` · ${runProgress}`}
        </Meta>
        <StepStatus $status={run.status}>{statusLabel(run.status)}</StepStatus>
      </RunHeader>
      {stale && (
        <Meta as="p" role="status">
          This run is no longer among the latest runs, so its status doesn't
          update.
        </Meta>
      )}
      <Steps aria-label="Steps">
        {steps.map(({ label, status, result, error }) => (
          <Step key={label}>
            <span>{label}</span>
            <StepStatus $status={status}>{statusLabel(status)}</StepStatus>
            {/* The server stores a step that returned undefined as null. */}
            {status === "finished" && result !== null && (
              <StepResult tabIndex={0} aria-label={`Value ${label} returned`}>
                {JSON.stringify(result, null, 2)}
              </StepResult>
            )}
            {error && (
              <StepFailure>
                <StepError>{error}</StepError>
                {retryButton}
              </StepFailure>
            )}
          </Step>
        ))}
      </Steps>
      {run.status === "finished" && run.result !== null && (
        <StepResult tabIndex={0} aria-label="Value the run returned">
          {JSON.stringify(run.result, null, 2)}
        </StepResult>
      )}
      {failed && !failedStep && (
        <StepFailure>
          {run.error && <StepError>{run.error.message}</StepError>}
          {retryButton}
        </StepFailure>
      )}
      <span role="status">
        {retryState?.status === "error" && (
          <ErrorText>{retryState.message}</ErrorText>
        )}
      </span>
    </div>
  );
}

// A row's Delete button and its confirmation. `remove()` deletes the row's
// record; on success, the row goes away with it. Returns `deleteRef` for
// the Delete button, `confirming`, `error`, and handlers `ask`, `confirm`,
// and `cancel`.
function useDelete(remove) {
  // null, or { status: "confirming" | "deleting" | "error", message? }
  const [state, setState] = useState(null);
  const deleteRef = useRef(null);

  return {
    deleteRef,
    confirming: state?.status === "confirming" || state?.status === "deleting",
    deleting: state?.status === "deleting",
    error: state?.status === "error" ? state.message : null,
    ask: () => setState({ status: "confirming" }),
    confirm: () => {
      setState({ status: "deleting" });
      remove().catch((error) =>
        setState({ status: "error", message: error.message }),
      );
    },
    cancel: () => {
      setState(null);
      deleteRef.current?.focus();
    },
  };
}

// Asks before deleting, since a delete can't be undone. Focus moves to
// Cancel, the safe choice, and Escape cancels. `children` is the question.
function DeleteConfirmation({ label, deleting, confirm, cancel, children }) {
  const cancelRef = useRef(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <Confirmation
      role="group"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape") cancel();
      }}
    >
      <Meta as="p">{children}</Meta>
      <Actions>
        <DestructiveButton type="button" onClick={confirm} disabled={deleting}>
          {deleting ? "Deleting…" : "Delete"}
        </DestructiveButton>
        <Button ref={cancelRef} type="button" onClick={cancel}>
          Cancel
        </Button>
      </Actions>
    </Confirmation>
  );
}

function RunRow({
  run,
  labels,
  selected,
  select,
  buttonRef,
  connected,
  remove,
}) {
  const runProgress = progress(labels, run);
  const deletion = useDelete(() => remove(run.id));
  const label = `Delete the run started ${dateFormat.format(run.startedAt)}`;

  return (
    <Row $selected={selected}>
      <SelectButton
        ref={buttonRef}
        type="button"
        onClick={select}
        aria-current={selected || undefined}
      >
        <Meta>
          Started <Time value={run.startedAt} />
          {runProgress && ` · ${runProgress}`}
        </Meta>
        <StepStatus $status={run.status}>{statusLabel(run.status)}</StepStatus>
      </SelectButton>
      <Actions>
        <Button
          ref={deletion.deleteRef}
          type="button"
          onClick={deletion.ask}
          disabled={!connected}
          aria-label={label}
          aria-expanded={deletion.confirming}
        >
          Delete
        </Button>
      </Actions>
      <RowStatus role="status">
        {deletion.error && <ErrorText>{deletion.error}</ErrorText>}
      </RowStatus>
      {deletion.confirming && (
        <DeleteConfirmation
          label={label}
          deleting={deletion.deleting}
          confirm={deletion.confirm}
          cancel={deletion.cancel}
        >
          Delete this run and its step results? You can't undo this.
        </DeleteConfirmation>
      )}
    </Row>
  );
}

// `waiting` is true after a start succeeds, until the new run appears and
// the panes open it.
function WorkflowRow({
  workflow,
  selected,
  select,
  buttonRef,
  connected,
  start,
  waiting,
  remove,
}) {
  const { id, triggers, url, updatedAt } = workflow;
  // null, or { status: "starting" | "error", message? }
  const [startState, setStartState] = useState(null);
  const deletion = useDelete(() => remove(id));

  const handleStart = () => {
    setStartState({ status: "starting" });
    start(id).then(
      () => setStartState(null),
      (error) => setStartState({ status: "error", message: error.message }),
    );
  };

  return (
    <Row $selected={selected}>
      <SelectButton
        ref={buttonRef}
        type="button"
        onClick={select}
        aria-current={selected || undefined}
      >
        <Details>
          <Name>{id}</Name>
          <Meta>
            {triggers?.event?.type ?? "No trigger"} · Updated{" "}
            <Time value={updatedAt} />
          </Meta>
          {!url && <Meta>Waiting for its app to sync.</Meta>}
        </Details>
      </SelectButton>
      <Actions>
        <Button
          type="button"
          onClick={handleStart}
          disabled={!connected || !url || startState?.status === "starting"}
          aria-label={`Start a run of ${id}`}
        >
          {startState?.status === "starting" ? "Starting…" : "Start"}
        </Button>
        <Button
          ref={deletion.deleteRef}
          type="button"
          onClick={deletion.ask}
          disabled={!connected}
          aria-label={`Delete ${id}`}
          aria-expanded={deletion.confirming}
        >
          Delete
        </Button>
      </Actions>
      <RowStatus role="status">
        {waiting && <Meta>Run started. Opening it…</Meta>}
        {startState?.status === "error" && (
          <ErrorText>{startState.message}</ErrorText>
        )}
        {deletion.error && <ErrorText>{deletion.error}</ErrorText>}
      </RowStatus>
      {deletion.confirming && (
        <DeleteConfirmation
          label={`Delete ${id}`}
          deleting={deletion.deleting}
          confirm={deletion.confirm}
          cancel={deletion.cancel}
        >
          Delete {id}
          {workflow.runs.length > 0 && " and all its runs"}? You can't undo
          this. If its app still defines the workflow, the next sync adds it
          back without runs.
        </DeleteConfirmation>
      )}
    </Row>
  );
}

export default function WorkflowList() {
  const { workflows, connection, reconnect, start, retry, remove, removeRun } =
    useWorkflows();
  // IDs rather than objects, so the panes show each update from the server.
  const [selection, select, back] = useSelection();
  const { workflowId: selectedWorkflowId, runId: selectedRunId } = selection;
  // The selected run as last listed, kept after it drops out of the latest
  // runs.
  const [knownRun, setKnownRun] = useState(null);
  // null, or { workflowId, knownRunIds } after a start succeeds, until the
  // new run appears.
  const [pendingStart, setPendingStart] = useState(null);
  const connected = connection === "open";
  const compact = useMediaQuery(COMPACT_QUERY);
  // In a narrow window, each selection opens a new pane, so it gets a history
  // entry for the browser's Back button. Side by side, it replaces the entry.
  const navigate = (next) => select(next, { push: compact });

  const selectedWorkflow = workflows?.find(
    ({ id }) => id === selectedWorkflowId,
  );
  const listedRun = selectedWorkflow?.runs.find(
    ({ id }) => id === selectedRunId,
  );
  const selectedRun =
    listedRun ?? (knownRun?.id === selectedRunId ? knownRun : null);

  useEffect(() => {
    if (listedRun) setKnownRun(listedRun);
  }, [listedRun]);

  const selectWorkflow = (id) =>
    navigate({
      workflowId: id,
      runId: id === selectedWorkflowId ? selectedRunId : null,
    });
  const selectRun = (id) =>
    navigate({ workflowId: selectedWorkflowId, runId: id });

  // Remembers the workflow's runs before the start, so the new run is the one
  // missing from them. The server's answer doesn't include the run's ID.
  const startRun = (id) => {
    const knownRunIds = new Set(
      workflows
        .find((workflow) => workflow.id === id)
        ?.runs.map((run) => run.id),
    );
    return start(id).then(() => {
      setPendingStart({ workflowId: id, knownRunIds });
      navigate({ workflowId: id, runId: null });
    });
  };

  // A deleted workflow's or run's row goes away, so focus moves to the
  // heading of its pane.
  const deleteWorkflow = (id) =>
    remove(id).then(() => {
      if (id === selectedWorkflowId) select({ workflowId: null, runId: null });
      headings.workflows.current?.focus();
    });
  const deleteRun = (id) =>
    removeRun(id).then(() => {
      if (id === selectedRunId) {
        select({ workflowId: selectedWorkflowId, runId: null });
      }
      headings.runs.current?.focus();
    });

  // Opens the new run once it appears, unless the person selected something
  // else in the meantime.
  useEffect(() => {
    if (!pendingStart) return;
    if (selectedWorkflowId !== pendingStart.workflowId || selectedRunId) {
      setPendingStart(null);
      return;
    }
    const run = workflows
      ?.find(({ id }) => id === pendingStart.workflowId)
      ?.runs.find(({ id }) => !pendingStart.knownRunIds.has(id));
    if (!run) return;
    setPendingStart(null);
    select({ workflowId: pendingStart.workflowId, runId: run.id });
  }, [workflows, pendingStart, selectedWorkflowId, selectedRunId, select]);

  // In a narrow window, the last pane with a selection to show is the only
  // one on screen. A selection hides the row that had focus, so focus moves
  // to the heading of the pane that replaces it. Going back, focus returns
  // to the row the person came from.
  let activePane = "workflows";
  if (selectedRun) activePane = "steps";
  else if (selectedWorkflow) activePane = "runs";
  const headings = {
    workflows: useRef(null),
    runs: useRef(null),
    steps: useRef(null),
  };
  // Select buttons by "workflow:<id>" or "run:<id>".
  const rows = useRef(new Map());
  const rowRef = (key) => (element) => {
    if (element) rows.current.set(key, element);
    else rows.current.delete(key);
  };
  const previous = useRef({ pane: activePane, ...selection });
  useEffect(() => {
    const from = previous.current;
    previous.current = { pane: activePane, ...selection };
    if (!compact || from.pane === activePane) return;
    const wentBack =
      PANE_ORDER.indexOf(activePane) < PANE_ORDER.indexOf(from.pane);
    const row =
      wentBack &&
      rows.current.get(
        activePane === "workflows"
          ? `workflow:${from.workflowId}`
          : `run:${from.runId}`,
      );
    (row || headings[activePane].current)?.focus();
  });
  const showPane = (pane) => !compact || pane === activePane;

  let workflowsContent;
  if (!workflows && connection !== "closed") {
    workflowsContent = <p role="status">Loading workflows…</p>;
  } else if (!workflows) {
    workflowsContent = (
      <ErrorMessage role="alert">
        <p>
          Can't connect to the workflow server. Check that it's running.
          Retrying automatically.
        </p>
        <Button type="button" onClick={reconnect}>
          Try again
        </Button>
      </ErrorMessage>
    );
  } else if (!workflows.length) {
    workflowsContent = (
      <Placeholder>
        No workflows yet. Workflows appear here after the runner creates them.
      </Placeholder>
    );
  } else {
    workflowsContent = (
      <List>
        {workflows.map((workflow) => (
          <WorkflowRow
            key={workflow.id}
            workflow={workflow}
            selected={workflow.id === selectedWorkflowId}
            select={() => selectWorkflow(workflow.id)}
            buttonRef={rowRef(`workflow:${workflow.id}`)}
            connected={connected}
            start={startRun}
            waiting={pendingStart?.workflowId === workflow.id}
            remove={deleteWorkflow}
          />
        ))}
      </List>
    );
  }

  let runsContent;
  if (!selectedWorkflow) {
    runsContent = <Placeholder>Select a workflow to see its runs.</Placeholder>;
  } else if (!selectedWorkflow.runs.length) {
    runsContent = (
      <Placeholder>
        No runs yet. To run this workflow, select Start next to it in Workflows.
      </Placeholder>
    );
  } else {
    runsContent = (
      <List aria-label={`Latest runs of ${selectedWorkflow.id}`}>
        {selectedWorkflow.runs.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            labels={selectedWorkflow.steps}
            selected={run.id === selectedRunId}
            select={() => selectRun(run.id)}
            buttonRef={rowRef(`run:${run.id}`)}
            connected={connected}
            remove={deleteRun}
          />
        ))}
      </List>
    );
  }

  let stepsContent;
  if (!selectedRun) {
    stepsContent = <Placeholder>Select a run to see its steps.</Placeholder>;
  } else {
    stepsContent = (
      <RunDetail
        workflowId={selectedWorkflow.id}
        labels={selectedWorkflow.steps}
        run={selectedRun}
        stale={!listedRun}
        canRetry={connected && Boolean(selectedWorkflow.url)}
        retry={retry}
      />
    );
  }

  return (
    <Section aria-label="Workflows and their runs">
      {/* Reconnect attempts are "connecting", so check for "open" to keep
          the banner up between them. */}
      <div role="status">
        {workflows && !connected && (
          <Banner>
            <WarningIcon />
            Lost connection to the workflow server. You can't start or retry
            runs until it reconnects. Reconnecting…
          </Banner>
        )}
      </div>
      <Panes $compact={compact}>
        {showPane("workflows") && (
          <Pane $compact={compact} aria-labelledby="workflows-heading">
            <PaneHeading
              id="workflows-heading"
              ref={headings.workflows}
              tabIndex={-1}
            >
              Workflows
            </PaneHeading>
            {workflowsContent}
          </Pane>
        )}
        {showPane("runs") && (
          <Pane $compact={compact} aria-labelledby="runs-heading">
            {compact && (
              <BackButton
                type="button"
                onClick={() => back({ workflowId: null, runId: null })}
              >
                Back to workflows
              </BackButton>
            )}
            <PaneHeading id="runs-heading" ref={headings.runs} tabIndex={-1}>
              {selectedWorkflow ? `Runs of ${selectedWorkflow.id}` : "Runs"}
            </PaneHeading>
            {runsContent}
          </Pane>
        )}
        {showPane("steps") && (
          <Pane $compact={compact} aria-labelledby="steps-heading">
            {compact && (
              <BackButton
                type="button"
                onClick={() =>
                  back({ workflowId: selectedWorkflowId, runId: null })
                }
              >
                Back to runs
              </BackButton>
            )}
            <PaneHeading id="steps-heading" ref={headings.steps} tabIndex={-1}>
              Steps
            </PaneHeading>
            {stepsContent}
          </Pane>
        )}
      </Panes>
    </Section>
  );
}
