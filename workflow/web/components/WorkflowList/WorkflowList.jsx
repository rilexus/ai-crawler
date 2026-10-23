import { useEffect, useState } from "react";
import {
  Actions,
  Button,
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
import useWorkflows from "./useWorkflows";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const STATUS_LABELS = {
  init: "Init",
  running: "Running",
  finished: "Finished",
  error: "Error",
  skipped: "Skipped",
};

const statusLabel = (status) => STATUS_LABELS[status] ?? status;

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

// The steps of the selected run, with their results and errors.
function RunDetail({ workflowId, labels, run, canRetry, retry }) {
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

  return (
    <div>
      <RunHeader>
        <Meta>
          {workflowId} · Started <Time value={run.startedAt} />
        </Meta>
        <StepStatus $status={run.status}>{statusLabel(run.status)}</StepStatus>
      </RunHeader>
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

function RunRow({ run, selected, select }) {
  return (
    <Row $selected={selected}>
      <SelectButton
        type="button"
        onClick={select}
        aria-current={selected || undefined}
      >
        <Meta>
          Started <Time value={run.startedAt} />
        </Meta>
        <StepStatus $status={run.status}>{statusLabel(run.status)}</StepStatus>
      </SelectButton>
    </Row>
  );
}

function WorkflowRow({ workflow, selected, select, connected, start }) {
  const { id, triggers, url, updatedAt } = workflow;
  // null, or { status: "starting" | "started" | "error", message? }
  const [startState, setStartState] = useState(null);

  const handleStart = () => {
    setStartState({ status: "starting" });
    start(id).then(
      () => setStartState({ status: "started" }),
      (error) => setStartState({ status: "error", message: error.message }),
    );
  };

  return (
    <Row $selected={selected}>
      <SelectButton
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
        <span role="status">
          {startState?.status === "started" && <Meta>Run started.</Meta>}
          {startState?.status === "error" && (
            <ErrorText>{startState.message}</ErrorText>
          )}
        </span>
      </Actions>
    </Row>
  );
}

export default function WorkflowList() {
  const { workflows, connection, reconnect, start, retry } = useWorkflows();
  // IDs rather than objects, so the panes show each update from the server.
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(null);
  const [selectedRunId, setSelectedRunId] = useState(null);
  const connected = connection === "open";

  const selectedWorkflow = workflows?.find(
    ({ id }) => id === selectedWorkflowId,
  );
  const selectedRun = selectedWorkflow?.runs.find(
    ({ id }) => id === selectedRunId,
  );

  const selectWorkflow = (id) => {
    setSelectedWorkflowId(id);
    if (id !== selectedWorkflowId) setSelectedRunId(null);
  };

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
            connected={connected}
            start={start}
          />
        ))}
      </List>
    );
  }

  let runsContent;
  if (!selectedWorkflow) {
    runsContent = <Placeholder>Select a workflow to see its runs.</Placeholder>;
  } else if (!selectedWorkflow.runs.length) {
    runsContent = <Placeholder>No runs yet.</Placeholder>;
  } else {
    runsContent = (
      <List aria-label={`Latest runs of ${selectedWorkflow.id}`}>
        {selectedWorkflow.runs.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            selected={run.id === selectedRunId}
            select={() => setSelectedRunId(run.id)}
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
        canRetry={connected && Boolean(selectedWorkflow.url)}
        retry={retry}
      />
    );
  }

  return (
    <Section aria-label="Workflows and their runs">
      {workflows && connection === "closed" && (
        <Meta as="p" role="status">
          Lost connection to the workflow server. Reconnecting…
        </Meta>
      )}
      <Panes>
        <Pane aria-labelledby="workflows-heading">
          <PaneHeading id="workflows-heading">Workflows</PaneHeading>
          {workflowsContent}
        </Pane>
        <Pane aria-labelledby="runs-heading">
          <PaneHeading id="runs-heading">Runs</PaneHeading>
          {runsContent}
        </Pane>
        <Pane aria-labelledby="steps-heading">
          <PaneHeading id="steps-heading">Steps</PaneHeading>
          {stepsContent}
        </Pane>
      </Panes>
    </Section>
  );
}
