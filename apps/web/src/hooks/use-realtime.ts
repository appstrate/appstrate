// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
import {
  runLogEventSchema,
  runMetricEventSchema,
  type RunLogEvent,
  type RunMetricEvent,
} from "@appstrate/shared-types";
import { getCurrentOrgId } from "../stores/org-store";
import { getCurrentSpaceId } from "./use-current-space";

// Re-export so existing consumers (run-detail.tsx) keep importing the metric
// event type from here; the source of truth is the shared Zod schema.
export type { RunLogEvent, RunMetricEvent } from "@appstrate/shared-types";

interface RunRealtimeHandlers {
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
 * Subscribe to log inserts and/or live metric updates for a single run via a
 * single SSE connection. Pass any subset of handlers — the connection
 * dispatches by event type and skips channels with no listener attached.
 *
 * Status patches are NOT served here: they arrive on the global stream
 * (`useGlobalRunSync`), which writes the same run cache key.
 */
export function useRunRealtime(runId: string | null | undefined, handlers: RunRealtimeHandlers) {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!runId) return;
    const orgId = getCurrentOrgId();
    const spaceId = getCurrentSpaceId();
    if (!orgId || !spaceId) return;

    // Only the two run channels dispatched below are declared: the per-run
    // stream would otherwise also carry `run_update` (status, already served
    // by the global stream), `connection_update` (every connection row the
    // caller owns) and `chat_session_update` for a page that listens to none
    // of them. `verbose=true` is still required — it is what keeps
    // `run_log.data` in the payload.
    const es = new EventSource(
      `/api/realtime/runs/${runId}?orgId=${encodeURIComponent(orgId)}&spaceId=${encodeURIComponent(spaceId)}&verbose=true&channels=run_log,run_metric`,
      { withCredentials: true },
    );

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
