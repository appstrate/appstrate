import { useEffect, useRef, useCallback } from "react";
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
 * Subscribe to execution status changes for a specific flow (e.g. running count updates).
 */
export function useFlowExecutionRealtime(flowId: string | null | undefined, callback: () => void) {
  const cbRef = useRef(callback);
  useEffect(() => {
    cbRef.current = callback;
  });

  useEffect(() => {
    if (!flowId) return;
    const orgId = getCurrentOrgId();
    if (!orgId) return;

    const es = new EventSource(
      `/api/realtime/flows/${flowId}/executions?orgId=${encodeURIComponent(orgId)}&verbose=true`,
      { withCredentials: true },
    );

    es.addEventListener("execution_update", () => {
      cbRef.current();
    });

    return () => {
      es.close();
    };
  }, [flowId]);
}

/**
 * Subscribe to all execution status changes (for flow list running counts).
 */
export function useAllExecutionsRealtime(callback: () => void) {
  const cbRef = useRef(callback);
  useEffect(() => {
    cbRef.current = callback;
  });

  const stableCallback = useCallback(() => cbRef.current(), []);

  useEffect(() => {
    const orgId = getCurrentOrgId();
    if (!orgId) return;

    const es = new EventSource(
      `/api/realtime/executions?orgId=${encodeURIComponent(orgId)}&verbose=true`,
      {
        withCredentials: true,
      },
    );

    es.addEventListener("execution_update", () => {
      stableCallback();
    });

    return () => {
      es.close();
    };
  }, [stableCallback]);
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
