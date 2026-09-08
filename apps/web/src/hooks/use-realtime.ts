// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  runLogEventSchema,
  runMetricEventSchema,
  runUpdateEventSchema,
  type RunLogEvent,
  type RunMetricEvent,
} from "@appstrate/shared-types";
import { getCurrentOrgId } from "../stores/org-store";
import { getCurrentSpaceId } from "./use-current-space";
import { withViewAsParam } from "../lib/scoping-headers";
import { useViewAsHeader } from "../stores/view-as-store";
import { patchRunDetail } from "./use-global-run-sync";

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
 * `run_update` is dispatched here rather than by a caller: the route answers
 * every connection with a status snapshot, applied to the same run cache key
 * the global stream writes — closing the gap when that stream missed a frame.
 */
export function useRunRealtime(runId: string | null | undefined, handlers: RunRealtimeHandlers) {
  // A dependency, not a convenience: `EventSource` reads its URL once, so
  // entering or leaving a preview has to close this stream and open a new one.
  const viewAs = useViewAsHeader();
  const qc = useQueryClient();
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!runId) return;
    const orgId = getCurrentOrgId();
    const spaceId = getCurrentSpaceId();
    if (!orgId || !spaceId) return;

    // Only the three run channels dispatched below are declared: the per-run
    // stream would otherwise also carry `connection_update` (every connection
    // row the caller owns) and `chat_session_update` for a page that listens
    // to neither. `verbose=true` is still required — it is what keeps
    // `run_log.data` in the payload.
    const es = new EventSource(
      withViewAsParam(
        `/api/realtime/runs/${runId}?orgId=${encodeURIComponent(orgId)}&spaceId=${encodeURIComponent(spaceId)}&verbose=true&channels=run_update,run_log,run_metric`,
        viewAs,
      ),
      { withCredentials: true },
    );

    es.addEventListener("run_update", (e) => {
      const parsed = runUpdateEventSchema.safeParse(safeJsonParse(e.data));
      if (parsed.success) patchRunDetail(qc, orgId, spaceId, parsed.data);
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
  }, [runId, qc, viewAs]);
}
