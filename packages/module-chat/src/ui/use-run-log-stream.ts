// SPDX-License-Identifier: Apache-2.0

/**
 * Follow a launched run's logs in the chat: fetch the persisted history once,
 * then tail new lines live over the run's SSE stream. Drives `RunPanel`.
 *
 * Two sources, merged by log id (they overlap):
 *  1. `GET /api/runs/:id/logs` — the persisted history, so a panel that mounts
 *     late (reopened conversation, or a `run_and_wait` whose run already
 *     finished) still shows everything.
 *  2. `GET /api/realtime/runs/:id?verbose=true` (EventSource) — the live tail
 *     while the run is in flight. Closed as soon as the run goes terminal.
 *
 * Auth mirrors the OAuth connect card: relative URLs, `credentials: "include"`
 * (cookie session), and the host's forwarded `X-Org-Id` / `X-Application-Id`
 * for the SSE query params (EventSource cannot send headers).
 */

import { useEffect, useState } from "react";
import { useChatHeaders } from "./runtime-context.ts";
import {
  buildRunSseUrl,
  isTerminalStatus,
  mergeLogs,
  orgAppFromHeaders,
  parseLogListResponse,
  parseRunLogFrame,
  parseRunUpdateFrame,
  type RunLogLine,
  type RunStatus,
} from "./run-events.ts";

export interface RunLogStream {
  logs: RunLogLine[];
  status: RunStatus | undefined;
  /** True while the live SSE tail is connected (run not yet terminal). */
  live: boolean;
}

/**
 * @param runId       the launched run id (`run_…`), or undefined to stay idle.
 * @param initialStatus status already known from the launch result (e.g.
 *                      `run_and_wait` returns a terminal run) — seeds the badge
 *                      and lets the hook skip the SSE when already terminal.
 */
export function useRunLogStream(runId: string | undefined, initialStatus?: string): RunLogStream {
  const getHeaders = useChatHeaders();
  const [logs, setLogs] = useState<RunLogLine[]>([]);
  const [status, setStatus] = useState<RunStatus | undefined>(
    isTerminalStatus(initialStatus) ? initialStatus : undefined,
  );
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    const headers = getHeaders?.() ?? {};
    const { orgId, applicationId } = orgAppFromHeaders(headers);

    const apply = (incoming: RunLogLine[]) => {
      if (cancelled || incoming.length === 0) return;
      setLogs((prev) => mergeLogs(prev, incoming));
    };

    // 1. History fetch (best-effort — a failure just means the live tail is the
    //    only source). Same-origin, cookie auth + forwarded org/app headers.
    void (async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/logs?limit=1000`, {
          headers,
          credentials: "include",
        });
        if (!res.ok || cancelled) return;
        apply(parseLogListResponse(await res.json()));
      } catch {
        // ignore — SSE remains the source of truth
      }
    })();

    // 2. Live tail. Skipped when org/app context or EventSource is unavailable
    //    (SSR / already terminal): the history fetch still populates the panel.
    const sseUrl = buildRunSseUrl({ runId, orgId, applicationId });
    if (!sseUrl || typeof EventSource === "undefined" || isTerminalStatus(initialStatus)) {
      return () => {
        cancelled = true;
      };
    }

    const es = new EventSource(sseUrl, { withCredentials: true });

    const closeLive = () => {
      es.close();
      if (!cancelled) setLive(false);
    };

    // setState only from external-system callbacks (open/message), never the
    // effect body — keeps the React static-rules gate happy.
    es.onopen = () => {
      if (!cancelled) setLive(true);
    };

    es.addEventListener("run_log", (e) => {
      const line = parseRunLogFrame((e as MessageEvent).data);
      if (line) apply([line]);
    });

    es.addEventListener("run_update", (e) => {
      const update = parseRunUpdateFrame((e as MessageEvent).data);
      if (!update || cancelled) return;
      setStatus(update.status as RunStatus);
      if (isTerminalStatus(update.status)) {
        // One final full history sweep to catch log lines the trigger may have
        // emitted in the same tick as the terminal status (mergeLogs dedups the
        // overlap), then stop tailing.
        void (async () => {
          try {
            const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/logs?limit=1000`, {
              headers,
              credentials: "include",
            });
            if (res.ok && !cancelled) apply(parseLogListResponse(await res.json()));
          } catch {
            // ignore
          } finally {
            closeLive();
          }
        })();
      }
    });

    es.onerror = () => {
      // EventSource auto-reconnects on transient errors; nothing to do. If the
      // run is already terminal we've closed it above, so this only fires on a
      // genuine network blip during an in-flight run.
    };

    return () => {
      cancelled = true;
      es.close();
    };
    // initialStatus is read once at subscribe time; runId is the real identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  return { logs, status, live };
}
