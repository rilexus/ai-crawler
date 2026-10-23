import { useCallback, useEffect, useRef, useState } from "react";

const MAX_RETRY_DELAY = 10_000;

// Subscribes to the workflow list over the server's WebSocket at /ws.
// Reconnects after a dropped connection, waiting 1 s and doubling the wait
// after each failed attempt, up to 10 s. `reconnect` retries right away.
//
// `workflows` is null until the first list arrives. `connection` is
// "connecting", "open", or "closed". `start(workflowId)` asks the server to
// start a new run, and `retry(runId)` to resume a failed one. Each resolves
// once the app accepts the request, and rejects with the server's error
// message.
export default function useWorkflows() {
  const [workflows, setWorkflows] = useState(null);
  const [connection, setConnection] = useState("connecting");
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  const socketRef = useRef(null);
  // Start and retry requests waiting for an answer, by request ID.
  const pending = useRef(new Map());
  const nextRequestId = useRef(1);

  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    socketRef.current = socket;
    let retryTimer;
    setConnection("connecting");

    const rejectPending = () => {
      for (const { reject } of pending.current.values()) {
        reject(new Error("Lost connection to the workflow server."));
      }
      pending.current.clear();
    };

    socket.onopen = () => {
      failures.current = 0;
      setConnection("open");
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "workflows") {
        setWorkflows(message.workflows);
      } else if (
        message.type === "start-result" ||
        message.type === "retry-result"
      ) {
        const request = pending.current.get(message.requestId);
        if (!request) return;
        pending.current.delete(message.requestId);
        if (message.ok) request.resolve();
        else request.reject(new Error(message.error));
      }
    };
    socket.onclose = () => {
      rejectPending();
      setConnection("closed");
      const delay = Math.min(1000 * 2 ** failures.current, MAX_RETRY_DELAY);
      failures.current += 1;
      retryTimer = setTimeout(() => setAttempt((n) => n + 1), delay);
    };

    return () => {
      clearTimeout(retryTimer);
      rejectPending();
      socket.onclose = null;
      socket.close();
    };
  }, [attempt]);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  // Sends a message that the server answers with a `<type>-result` message.
  const request = useCallback(
    (message) =>
      new Promise((resolve, reject) => {
        const socket = socketRef.current;
        if (socket?.readyState !== WebSocket.OPEN) {
          reject(new Error("Not connected to the workflow server."));
          return;
        }
        const requestId = nextRequestId.current++;
        pending.current.set(requestId, { resolve, reject });
        socket.send(JSON.stringify({ ...message, requestId }));
      }),
    [],
  );
  const start = useCallback(
    (workflowId) => request({ type: "start", workflowId }),
    [request],
  );
  const retry = useCallback(
    (runId) => request({ type: "retry", runId }),
    [request],
  );

  return { workflows, connection, reconnect, start, retry };
}
