import { useState } from "react";
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
  Section,
  Step,
  StepError,
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

// Returns the registered steps with their status in the latest run, followed
// by steps the run reached that weren't registered. Steps the run hasn't
// reached yet are "init".
function stepsWithStatus(labels, lastRun) {
  const runSteps = new Map(
    (lastRun?.steps ?? []).map((step) => [step.label, step]),
  );
  return [...new Set([...labels, ...runSteps.keys()])].map((label) => ({
    label,
    status: runSteps.get(label)?.status ?? "init",
    result: runSteps.get(label)?.result ?? null,
    error: runSteps.get(label)?.error?.message,
  }));
}

function WorkflowRow({ workflow, canStart, start }) {
  const { id, triggers, url, updatedAt, lastRun } = workflow;
  const steps = stepsWithStatus(workflow.steps, lastRun);
  // null, or { status: "starting" | "started" | "error", message? }
  const [result, setResult] = useState(null);

  const handleStart = () => {
    setResult({ status: "starting" });
    start(id).then(
      () => setResult({ status: "started" }),
      (error) => setResult({ status: "error", message: error.message }),
    );
  };

  return (
    <Row>
      <Details>
        <Name>{id}</Name>
        <Meta>
          {triggers?.event?.type ?? "No trigger"} · Updated{" "}
          <time dateTime={new Date(updatedAt).toISOString()}>
            {dateFormat.format(updatedAt)}
          </time>
        </Meta>
        {!url && <Meta>Waiting for its app to sync.</Meta>}
        {lastRun && (
          <Meta>
            Last run: {statusLabel(lastRun.status)} · Started{" "}
            <time dateTime={new Date(lastRun.startedAt).toISOString()}>
              {dateFormat.format(lastRun.startedAt)}
            </time>
          </Meta>
        )}
        {steps.length > 0 && (
          <Steps aria-label={`Steps of ${id}`}>
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
                {error && <StepError>{error}</StepError>}
              </Step>
            ))}
          </Steps>
        )}
      </Details>
      <Actions>
        <Button
          type="button"
          onClick={handleStart}
          disabled={!canStart || !url || result?.status === "starting"}
          aria-label={`Start ${id}`}
        >
          {result?.status === "starting" ? "Starting…" : "Start"}
        </Button>
        <span role="status">
          {result?.status === "started" && <Meta>Run started.</Meta>}
          {result?.status === "error" && (
            <ErrorText>{result.message}</ErrorText>
          )}
        </span>
      </Actions>
    </Row>
  );
}

export default function WorkflowList() {
  const { workflows, connection, reconnect, start } = useWorkflows();

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
            canStart={connection === "open"}
            start={start}
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
