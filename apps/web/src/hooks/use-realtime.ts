// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { realtimeRunsUrl } from "@appstrate/core/realtime-url";
import {
  runLogEventSchema,
  runMetricEventSchema,
  runUpdateEventSchema,
  type RunLogEvent,
  type RunMetricEvent,
} from "@appstrate/shared-types";
import { useCurrentOrgId } from "./use-org";
import { useCurrentSpaceId } from "./use-current-space";
import { useViewAsHeader } from "../stores/view-as-store";
import { patchRunDetail } from "./use-global-run-sync";

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
 * Subscribe to log inserts and/or live metric updates for one run over a single SSE connection.
 * `run_update` is applied here too: the route opens every connection with a status snapshot,
 * closing the gap when the global stream missed a frame.
 */
export function useRunRealtime(runId: string | null | undefined, handlers: RunRealtimeHandlers) {
  // A dependency: `EventSource` reads its URL once, so entering/leaving a preview must reopen it.
  const viewAs = useViewAsHeader();
  const orgId = useCurrentOrgId();
  const spaceId = useCurrentSpaceId();
  const qc = useQueryClient();
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!runId || !orgId || !spaceId) return;

    // Declare only the dispatched channels, or the stream also carries `connection_update` and
    // `chat_session_update`. `verbose` keeps `run_log.data` in the payload.
    const es = new EventSource(
      realtimeRunsUrl({
        orgId,
        spaceId,
        runId,
        verbose: true,
        channels: ["run_update", "run_log", "run_metric"],
        viewAs,
      }),
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
  }, [runId, orgId, spaceId, qc, viewAs]);
}
