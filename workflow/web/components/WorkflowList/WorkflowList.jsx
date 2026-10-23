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
  Row,
  RowHeader,
  Run,
  RunHeader,
  Runs,
  Section,
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

function RunItem({ workflowId, labels, run, canRetry, retry }) {
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
    <Run>
      <RunHeader>
        <Meta>
          Run started <Time value={run.startedAt} />
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
    </Run>
  );
}

function WorkflowRow({ workflow, connected, start, retry }) {
  const { id, triggers, url, updatedAt, runs } = workflow;
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
    <Row>
      <RowHeader>
        <Details>
          <Name>{id}</Name>
          <Meta>
            {triggers?.event?.type ?? "No trigger"} · Updated{" "}
            <Time value={updatedAt} />
          </Meta>
          {workflow.steps.length > 0 && (
            <Meta>Steps: {workflow.steps.join(", ")}</Meta>
          )}
          {!url && <Meta>Waiting for its app to sync.</Meta>}
        </Details>
        <Actions>
          <Button
            type="button"
            onClick={handleStart}
            disabled={
              !connected || !url || startState?.status === "starting"
            }
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
      </RowHeader>
      {runs.length > 0 ? (
        <Runs aria-label={`Latest runs of ${id}`}>
          {runs.map((run) => (
            <RunItem
              key={run.id}
              workflowId={id}
              labels={workflow.steps}
              run={run}
              canRetry={connected && Boolean(url)}
              retry={retry}
            />
          ))}
        </Runs>
      ) : (
        <Meta>No runs yet.</Meta>
      )}
    </Row>
  );
}

export default function WorkflowList() {
  const { workflows, connection, reconnect, start, retry } = useWorkflows();

  let content;
  if (!workflows && connection !== "closed") {
    content = <p role="status">Loading workflows…</p>;
  } else if (!workflows) {
    content = (
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
    content = (
      <p>
        No workflows yet. Workflows appear here after the runner creates them.
      </p>
    );
  } else {
    content = (
      <List>
        {workflows.map((workflow) => (
          <WorkflowRow
            key={workflow.id}
            workflow={workflow}
            connected={connection === "open"}
            start={start}
            retry={retry}
          />
        ))}
      </List>
    );
  }

  return (
    <Section aria-labelledby="workflows-heading">
      <h2 id="workflows-heading">Workflows</h2>
      {workflows && connection === "closed" && (
        <Meta as="p" role="status">
          Lost connection to the workflow server. Reconnecting…
        </Meta>
      )}
      {content}
    </Section>
  );
}
