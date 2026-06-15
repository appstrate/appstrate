// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
import {
  runUpdateEventSchema,
  runLogEventSchema,
  runMetricEventSchema,
  type RunUpdateEvent,
  type RunLogEvent,
  type RunMetricEvent,
} from "@appstrate/shared-types";
import { getCurrentOrgId } from "../stores/org-store";
import { getCurrentApplicationId } from "./use-current-application";

// Re-export so existing consumers (run-detail.tsx) keep importing the metric
// event type from here; the source of truth is the shared Zod schema.
export type { RunUpdateEvent, RunLogEvent, RunMetricEvent } from "@appstrate/shared-types";

interface RunRealtimeHandlers {
  onStatusChange?: (payload: RunUpdateEvent) => void;
  onNewLog?: (log: RunLogEvent) => void;
  onMetric?: (metric: RunMetricEvent) => void;
}

/** Parse JSON, returning `undefined` on malformed input (then safeParse rejects). */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Subscribe to run status changes, log inserts, and/or live metric updates
 * for a single run via a single SSE connection. Pass any subset of handlers
 * — the connection dispatches by event type and skips channels with no
 * listener attached.
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
      const parsed = runUpdateEventSchema.safeParse(safeJsonParse(e.data));
      if (parsed.success) handlersRef.current.onStatusChange?.(parsed.data);
    });

    es.addEventListener("run_log", (e) => {
      const parsed = runLogEventSchema.safeParse(safeJsonParse(e.data));
      if (parsed.success) handlersRef.current.onNewLog?.(parsed.data);
    });

    es.addEventListener("run_metric", (e) => {
      const parsed = runMetricEventSchema.safeParse(safeJsonParse(e.data));
      if (parsed.success) handlersRef.current.onMetric?.(parsed.data);
    });

    return () => {
      es.close();
    };
  }, [runId]);
}
