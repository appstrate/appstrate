// SPDX-License-Identifier: Apache-2.0

/**
 * Live run events via the platform's per-run SSE stream
 * (GET /api/realtime/runs/:id): `run_log` inserts + `run_update` status flips.
 *
 * Ported from apps/web's `useRunRealtime` — a module can't import app hooks, so
 * this is a thin local copy that reads org/app from the shell's scoping headers
 * (getHeaders) instead of web stores. EventSource (the browser parses SSE frames
 * natively); only meaningful while a run is in flight, so pass `runId = null`
 * once it reaches a terminal state to close the stream.
 */

import { useEffect, useRef } from "react";
import type { GetHeaders } from "./sessions.ts";

interface RunEventHandlers {
  onLog?: (log: unknown) => void;
  onStatus?: (update: { status?: string }) => void;
}

export function useRunEvents(
  runId: string | null,
  getHeaders: GetHeaders,
  handlers: RunEventHandlers,
): void {
  // Keep handlers fresh without re-opening the stream on every render.
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    if (!runId) return;
    const h = getHeaders?.() ?? {};
    const orgId = h["X-Org-Id"];
    const applicationId = h["X-Application-Id"];
    // SSE can't send headers, so the shell's org/app context goes on the query
    // string (cookie auth path of validateSSEAuth). No context → no stream.
    if (!orgId || !applicationId) return;

    const qs = new URLSearchParams({ orgId, applicationId, verbose: "true" });
    const es = new EventSource(`/api/realtime/runs/${runId}?${qs}`, { withCredentials: true });

    es.addEventListener("run_log", (e) => {
      try {
        ref.current.onLog?.(JSON.parse((e as MessageEvent).data));
      } catch {
        // Ignore malformed SSE payloads.
      }
    });
    es.addEventListener("run_update", (e) => {
      try {
        ref.current.onStatus?.(JSON.parse((e as MessageEvent).data));
      } catch {
        // Ignore malformed SSE payloads.
      }
    });

    return () => es.close();
  }, [runId, getHeaders]);
}
