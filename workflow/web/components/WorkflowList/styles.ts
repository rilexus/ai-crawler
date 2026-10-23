import styled from "styled-components";

export const Section = styled.section`
  margin-top: 2rem;
`;

// Workflows, the selected workflow's runs, and the selected run's steps,
// side by side. Narrow windows stack the panes instead of squeezing them.
export const Panes = styled.div`
  display: grid;
  grid-template-columns: minmax(16rem, 1fr) minmax(14rem, 1fr) minmax(
      20rem,
      1.5fr
    );
  gap: 1.5rem;
  align-items: start;

  @media (max-width: 60rem) {
    grid-template-columns: 1fr;
  }
`;

export const Pane = styled.section`
  min-width: 0;
`;

export const PaneHeading = styled.h2`
  margin: 0 0 0.75rem;
  font-size: 1.125rem;
`;

// #595959 on white has a 7:1 contrast ratio.
export const Placeholder = styled.p`
  margin: 0;
  color: #595959;
`;

export const List = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid #c4c4c4;
  border-radius: 8px;
  overflow: hidden;
`;

// A selectable workflow or run. The selected row keeps a highlight, which
// ties it to the pane it fills. #1f1f1f on #e8f0fe has a 14.5:1 contrast
// ratio.
export const Row = styled.li<{ $selected?: boolean }>`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-inline-start: 3px solid
    ${({ $selected }) => ($selected ? "#0b57d0" : "transparent")};
  background: ${({ $selected }) => ($selected ? "#e8f0fe" : "transparent")};

  & + & {
    border-top: 1px solid #c4c4c4;
  }
`;

// Fills the row, so the whole row except its actions selects it.
export const SelectButton = styled.button`
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  min-height: 2.75rem;
  padding: 0.75rem 1rem;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;

  &:hover {
    background: rgb(0 0 0 / 4%);
  }

  &:focus-visible {
    outline: 2px solid #0b57d0;
    outline-offset: -2px;
  }
`;

export const RunHeader = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: 0.5rem;
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
  padding-inline-end: 1rem;
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
