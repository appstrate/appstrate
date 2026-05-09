// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { invalidateRunAndNotificationQueries } from "./use-notifications";
import { type Run, type RunStatus, TERMINAL_RUN_STATUSES } from "@appstrate/shared-types";

function handleSSEMessage(qc: QueryClient, orgId: string, applicationId: string, raw: string) {
  try {
    const newRow = JSON.parse(raw) as Record<string, unknown>;
    const packageId = newRow.packageId as string;
    const runId = newRow.id as string;
    const status = newRow.status as string;
    const scheduleId = newRow.scheduleId as string | null;

    qc.setQueryData<Run>(["run", orgId, applicationId, runId], (prev) => {
      if (!prev) return prev;
      return { ...prev, ...newRow } as Run;
    });

    qc.setQueryData<Run[]>(["runs", orgId, applicationId, packageId], (prev) => {
      if (!prev) return prev;
      const exists = prev.some((ex) => ex.id === runId);
      if (exists) {
        return prev.map((ex) => (ex.id === runId ? ({ ...ex, ...newRow } as Run) : ex));
      }
      return [newRow as Run, ...prev].slice(0, 50);
    });

    qc.invalidateQueries({ queryKey: ["agents", orgId] });
    qc.invalidateQueries({ queryKey: ["packages", "agent", orgId, packageId] });
    qc.invalidateQueries({ queryKey: ["paginated-runs"] });

    // Invalidate schedule-specific caches
    if (scheduleId) {
      qc.invalidateQueries({ queryKey: ["schedule-runs", orgId, applicationId, scheduleId] });
      qc.invalidateQueries({ queryKey: ["schedule", orgId, applicationId, scheduleId] });
      qc.invalidateQueries({ queryKey: ["schedules", orgId, applicationId] });
    }

    if (TERMINAL_RUN_STATUSES.has(status as RunStatus)) {
      invalidateRunAndNotificationQueries(qc);
      qc.invalidateQueries({ queryKey: ["billing", orgId] });
    }
  } catch {
    // Ignore malformed payloads
  }
}

/**
 * Global SSE subscription on run changes.
 * Uses fetch + ReadableStream instead of EventSource to avoid
 * Safari's aggressive auto-reconnect behavior on connection failure.
 */
export function useGlobalRunSync() {
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  const qcRef = useRef(qc);
  qcRef.current = qc;

  useEffect(() => {
    if (!orgId || !applicationId) return;

    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch(
          `/api/realtime/runs?orgId=${encodeURIComponent(orgId)}&applicationId=${encodeURIComponent(applicationId)}&verbose=true`,
          {
            credentials: "include",
            signal: controller.signal,
          },
        );
        if (!res.ok || !res.body) return;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop()!;

          for (const part of parts) {
            let event = "";
            let data = "";
            for (const line of part.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data = line.slice(5).trim();
            }
            if (event === "run_update" && data) {
              handleSSEMessage(qcRef.current, orgId, applicationId, data);
            }
          }
        }
      } catch {
        // Connection failed or aborted — no auto-reconnect
      }
    })();

    return () => controller.abort();
  }, [orgId, applicationId]);
}
