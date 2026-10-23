import styled from "styled-components";

export const Section = styled.section`
  max-width: 40rem;
  margin-top: 2rem;
`;

export const List = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid #c4c4c4;
  border-radius: 8px;
`;

// A workflow template, with its latest runs below it.
export const Row = styled.li`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.75rem 1rem;

  & + & {
    border-top: 1px solid #c4c4c4;
  }
`;

export const RowHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
`;

export const Runs = styled.ol`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  list-style: none;
  margin: 0;
  padding: 0;
`;

// One run of the workflow, set off from the template by an indent and a
// rule.
export const Run = styled.li`
  min-width: 0;
  padding-inline-start: 0.75rem;
  border-inline-start: 3px solid #c4c4c4;
`;

export const RunHeader = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
`;

export const Details = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
`;

export const Name = styled.span`
  font-weight: 600;
  overflow-wrap: anywhere;
`;

// #595959 on white has a 7:1 contrast ratio.
export const Meta = styled.span`
  color: #595959;
  font-size: 0.875rem;
`;

export const Steps = styled.ol`
  margin: 0.25rem 0 0;
  padding-inline-start: 1.25rem;
  font-size: 0.875rem;
`;

export const Step = styled.li`
  & > span:first-child {
    overflow-wrap: anywhere;
  }
`;

// Text and background colors by step status. Each pair has a contrast ratio
// of at least 5.5:1. The label text carries the status, not the color alone.
const STATUS_COLORS = {
  running: ["#0b57d0", "#e8f0fe"],
  finished: ["#146c2e", "#e6f4ea"],
  error: ["#b00020", "#fce8e6"],
};
const DEFAULT_STATUS_COLORS = ["#595959", "#f0f0f0"];

export const StepStatus = styled.span<{ $status: string }>`
  margin-inline-start: 0.5rem;
  padding: 0 0.375rem;
  border-radius: 4px;
  color: ${({ $status }) => (STATUS_COLORS[$status] ?? DEFAULT_STATUS_COLORS)[0]};
  background: ${({ $status }) =>
    (STATUS_COLORS[$status] ?? DEFAULT_STATUS_COLORS)[1]};
  font-size: 0.75rem;
`;

// Scrolls inside the row when a returned value is long. #1f1f1f on #f6f6f6
// has a 15.4:1 contrast ratio.
export const StepResult = styled.pre`
  max-height: 10rem;
  margin: 0.25rem 0 0.5rem;
  padding: 0.25rem 0.5rem;
  overflow: auto;
  border-radius: 4px;
  background: #f6f6f6;
  color: #1f1f1f;
  font-size: 0.75rem;

  &:focus-visible {
    outline: 2px solid #0b57d0;
    outline-offset: 2px;
  }
`;

// #b00020 on white has a 7.3:1 contrast ratio.
export const StepError = styled.p`
  margin: 0;
  color: #b00020;
  font-size: 0.75rem;
  overflow-wrap: anywhere;
`;

// Puts a failed step's error next to its Retry button.
export const StepFailure = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0.25rem 0 0.5rem;
`;

export const Actions = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.25rem;
  flex-shrink: 0;
`;

export const ErrorMessage = styled.div`
  color: #b00020;
`;

// #b00020 on white has a 7.3:1 contrast ratio.
export const ErrorText = styled.span`
  color: #b00020;
  font-size: 0.875rem;
  max-width: 14rem;
  text-align: end;
`;

export const Button = styled.button`
  min-height: 2.75rem;
  padding: 0 1rem;
  font: inherit;
  cursor: pointer;
`;
