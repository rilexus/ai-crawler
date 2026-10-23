import { useCallback, useEffect, useState } from "react";

// The selected workflow and run, kept in the URL as `?workflow=…&run=…` so a
// reload or a shared link shows the same panes.
function readSelection() {
  const params = new URLSearchParams(location.search);
  return { workflowId: params.get("workflow"), runId: params.get("run") };
}

const sameSelection = (a, b) =>
  (a?.workflowId ?? null) === (b?.workflowId ?? null) &&
  (a?.runId ?? null) === (b?.runId ?? null);

// Returns `[selection, select, back]`.
//
// `select(next, { push })` changes the selection and the URL. With `push`, it
// adds a history entry, so the browser's Back button returns to the previous
// selection; otherwise it replaces the current entry. `back(parent)` returns
// to `parent`: through history when the previous entry is `parent`, so Back
// and Forward stay in step, or with a new entry otherwise, such as when the
// page opened on a link to a run.
export default function useSelection() {
  const [selection, setSelection] = useState(readSelection);

  useEffect(() => {
    const update = () => setSelection(readSelection());
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);

  const select = useCallback((next, { push = false } = {}) => {
    const from = readSelection();
    const params = new URLSearchParams(location.search);
    for (const [key, value] of [
      ["workflow", next.workflowId],
      ["run", next.runId],
    ]) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    const url = `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
    // Each pushed entry records the selection it came from, for `back`.
    if (push) history.pushState({ from }, "", url);
    else history.replaceState(history.state, "", url);
    setSelection(next);
  }, []);

  const back = useCallback(
    (parent) => {
      if (sameSelection(history.state?.from, parent)) history.back();
      else select(parent, { push: true });
    },
    [select],
  );

  return [selection, select, back];
}
