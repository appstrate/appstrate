// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
import { getCurrentOrgId } from "./use-org";

/**
 * Subscribe to run status changes + log inserts for a single run via SSE.
 */
export function useRunRealtime(
  runId: string | null | undefined,
  onStatusChange?: (payload: Record<string, unknown>) => void,
) {
  const onStatusRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusRef.current = onStatusChange;
  });

  useEffect(() => {
    if (!runId) return;
    const orgId = getCurrentOrgId();
    if (!orgId) return;

    const es = new EventSource(
      `/api/realtime/runs/${runId}?orgId=${encodeURIComponent(orgId)}&verbose=true`,
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
  }, [runId]);
}

/**
 * Subscribe to run_logs INSERTs via SSE.
 */
export function useRunLogsRealtime(
  runId: string | null | undefined,
  onNewLog: (log: Record<string, unknown>) => void,
) {
  const onNewLogRef = useRef(onNewLog);
  useEffect(() => {
    onNewLogRef.current = onNewLog;
  });

  useEffect(() => {
    if (!runId) return;
    const orgId = getCurrentOrgId();
    if (!orgId) return;

    const es = new EventSource(
      `/api/realtime/runs/${runId}?orgId=${encodeURIComponent(orgId)}&verbose=true`,
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
  }, [runId]);
}
