// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
import { getCurrentOrgId } from "./use-org";
import { getCurrentApplicationId } from "./use-current-application";

interface RunRealtimeHandlers {
  onStatusChange?: (payload: Record<string, unknown>) => void;
  onNewLog?: (log: Record<string, unknown>) => void;
}

/**
 * Subscribe to run status changes and/or log inserts for a single run via
 * a single SSE connection. Pass any subset of handlers — the connection
 * dispatches by event type and skips channels with no listener attached.
 */
export function useRunRealtime(runId: string | null | undefined, handlers: RunRealtimeHandlers) {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!runId) return;
    const orgId = getCurrentOrgId();
    const applicationId = getCurrentApplicationId();
    if (!orgId || !applicationId) return;

    const es = new EventSource(
      `/api/realtime/runs/${runId}?orgId=${encodeURIComponent(orgId)}&applicationId=${encodeURIComponent(applicationId)}&verbose=true`,
      { withCredentials: true },
    );

    es.addEventListener("run_update", (e) => {
      try {
        const data = JSON.parse(e.data);
        handlersRef.current.onStatusChange?.(data);
      } catch {
        // Ignore malformed SSE payloads
      }
    });

    es.addEventListener("run_log", (e) => {
      try {
        const data = JSON.parse(e.data);
        handlersRef.current.onNewLog?.(data);
      } catch {
        // Ignore malformed SSE payloads
      }
    });

    return () => {
      es.close();
    };
  }, [runId]);
}
