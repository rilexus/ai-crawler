import styled, { css } from "styled-components";

// Narrower windows show one pane at a time instead of squeezing three.
export const COMPACT_QUERY = "(max-width: 60rem)";

// Colors come from the tokens in global-styles.ts, which list their contrast
// ratios.

export const Section = styled.section`
  margin-top: 2rem;
`;

// Shows that the server connection dropped, above the panes, since it
// disables every Start and Retry button.
export const Banner = styled.p`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 1rem;
  padding: 0.75rem 1rem;
  border: 1px solid currentColor;
  border-radius: 8px;
  background: var(--color-warning-bg);
  color: var(--color-warning);

  & > svg {
    flex-shrink: 0;
  }
`;

// Workflows, the selected workflow's runs, and the selected run's steps,
// side by side.
export const Panes = styled.div<{ $compact: boolean }>`
  display: grid;
  grid-template-columns: ${({ $compact }) =>
    $compact
      ? "1fr"
      : "minmax(16rem, 1fr) minmax(14rem, 1fr) minmax(20rem, 1.5fr)"};
  gap: 1.5rem;
  align-items: start;
`;

// Side by side, each pane scrolls on its own and stays in view, so the pane
// a selection fills is visible however far down the selected row is. The
// padding keeps focus outlines inside the scroll area.
export const Pane = styled.section<{ $compact: boolean }>`
  min-width: 0;

  ${({ $compact }) =>
    !$compact &&
    css`
      position: sticky;
      top: 0;
      max-height: 100dvh;
      overflow-y: auto;
      padding: 0.25rem;
    `}
`;

export const PaneHeading = styled.h2`
  margin: 0 0 0.75rem;
  font-size: 1.125rem;
  overflow-wrap: anywhere;
`;

export const Placeholder = styled.p`
  margin: 0;
  color: var(--color-text-secondary);
`;

export const List = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
`;

export const Actions = styled.div`
  flex-shrink: 0;
  padding-inline-end: 1rem;
`;

// A selectable workflow or run. The selected row keeps a highlight, which
// ties it to the pane it fills. With a mouse, a row shows its actions only
// while it's hovered, focused, or selected, so the one being pointed at
// stands out. Touch screens always show them.
export const Row = styled.li<{ $selected?: boolean }>`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  border-inline-start: 3px solid
    ${({ $selected }) => ($selected ? "var(--color-accent)" : "transparent")};
  background: ${({ $selected }) =>
    $selected ? "var(--color-selected-bg)" : "transparent"};

  & + & {
    border-top: 1px solid var(--color-border);
  }

  @media (hover: hover) and (pointer: fine) {
    ${({ $selected }) =>
      !$selected &&
      css`
        &:not(:hover, :focus-within) ${Actions} {
          opacity: 0;
        }
      `}
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
    background: var(--color-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--color-accent);
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

export const Meta = styled.span`
  color: var(--color-text-secondary);
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

// Text and background tokens by step status. Running has its own hue, so a
// running badge stays visible on a selected row. The label text carries the
// status, not the color alone.
const STATUS_COLORS = {
  running: "running",
  finished: "success",
  error: "error",
};

const statusColor = ({ $status }: { $status: string }) =>
  STATUS_COLORS[$status] ?? "neutral";

export const StepStatus = styled.span<{ $status: string }>`
  margin-inline-start: 0.5rem;
  padding: 0 0.375rem;
  border-radius: 4px;
  color: var(--color-${statusColor});
  background: var(--color-${statusColor}-bg);
  font-size: 0.75rem;
`;

// Scrolls inside the row when a returned value is long.
export const StepResult = styled.pre`
  max-height: 10rem;
  margin: 0.25rem 0 0.5rem;
  padding: 0.25rem 0.5rem;
  overflow: auto;
  border-radius: 4px;
  background: var(--color-code-bg);
  color: var(--color-text);
  font-size: 0.75rem;

  &:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
`;

export const StepError = styled.p`
  margin: 0;
  color: var(--color-error);
  font-size: 0.875rem;
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

// A message about the row's action, on its own line below the row so a
// long one doesn't squeeze the row's name.
export const RowStatus = styled.span`
  flex-basis: 100%;
  padding-inline: 1rem;

  &:not(:empty) {
    padding-bottom: 0.75rem;
  }
`;

export const ErrorMessage = styled.div`
  color: var(--color-error);
`;

export const ErrorText = styled.span`
  color: var(--color-error);
  font-size: 0.875rem;
  overflow-wrap: anywhere;
`;

export const Button = styled.button`
  min-height: 2.75rem;
  padding: 0 1rem;
  font: inherit;
  cursor: pointer;
`;

export const BackButton = styled(Button)`
  margin-bottom: 0.5rem;
`;
