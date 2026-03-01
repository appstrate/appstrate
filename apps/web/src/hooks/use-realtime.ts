import { useEffect, useRef } from "react";
import { getCurrentOrgId } from "./use-org";

/**
 * Subscribe to execution status changes + log inserts for a single execution via SSE.
 */
export function useExecutionRealtime(
  executionId: string | null | undefined,
  onStatusChange?: (payload: Record<string, unknown>) => void,
) {
  const onStatusRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusRef.current = onStatusChange;
  });

  useEffect(() => {
    if (!executionId) return;
    const orgId = getCurrentOrgId();
    if (!orgId) return;

    const es = new EventSource(
      `/api/realtime/executions/${executionId}?orgId=${encodeURIComponent(orgId)}&verbose=true`,
      { withCredentials: true },
    );

    es.addEventListener("execution_update", (e) => {
      try {
        const data = JSON.parse(e.data);
        onStatusRef.current?.(data);
      } catch {
        // Ignore malformed SSE payloads
      }
    });

    return () => {
      es.close();
    };
  }, [executionId]);
}

/**
 * Subscribe to execution_logs INSERTs via SSE.
 */
export function useExecutionLogsRealtime(
  executionId: string | null | undefined,
  onNewLog: (log: Record<string, unknown>) => void,
) {
  const onNewLogRef = useRef(onNewLog);
  useEffect(() => {
    onNewLogRef.current = onNewLog;
  });

  useEffect(() => {
    if (!executionId) return;
    const orgId = getCurrentOrgId();
    if (!orgId) return;

    const es = new EventSource(
      `/api/realtime/executions/${executionId}?orgId=${encodeURIComponent(orgId)}&verbose=true`,
      { withCredentials: true },
    );

    es.addEventListener("execution_log", (e) => {
      try {
        const data = JSON.parse(e.data);
        onNewLogRef.current(data);
      } catch {
        // Ignore malformed SSE payloads
      }
    });

    return () => {
      es.close();
    };
  }, [executionId]);
}
