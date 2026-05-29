// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { invalidateRunAndNotificationQueries } from "./use-notifications";
import { type EnrichedRun, type RunStatus, TERMINAL_RUN_STATUSES } from "@appstrate/shared-types";

/**
 * Patch caches when an `integration_connections` row changes (INSERT /
 * UPDATE / DELETE) — drives the live "Reconnection required" badge on
 * the connections page, the agent picker verdict, the integration detail
 * connection list, and the agent status cards. Without this they refresh
 * only on window focus and stay stale across tabs.
 *
 * Server-side actor filter in `services/realtime.ts:connection_update`
 * means we only see our own rows; cross-actor invalidations (e.g.
 * someone else sharing a connection) still rely on a focus refetch,
 * which is acceptable because the run-time resolver gate enforces the
 * server-side truth anyway.
 */
function handleConnectionUpdate(qc: QueryClient, orgId: string, applicationId: string) {
  // Connections page (`/preferences/connections`) — the orange
  // "Reconnection required" badge reads off this key. The hook
  // (`use-me-connections.ts`) keys flat, so we invalidate flat.
  qc.invalidateQueries({ queryKey: ["me-connections"] });
  // Integration list (sidebar status, integrations page count) +
  // detail subtree (auth statuses, connection lists, agent-resolution
  // verdicts). Subtree-invalidate by ["integrations", orgId, appId] —
  // the per-integration key shape is
  // `[...KEY(orgId, appId), "detail" | "connections" | "agent-resolution", …]`
  // so the prefix match cascades to every sub-key, including the
  // resolution verdict that powers the agent picker dropdown.
  qc.invalidateQueries({ queryKey: ["integrations", orgId, applicationId] });
}

function handleSSEMessage(qc: QueryClient, orgId: string, applicationId: string, raw: string) {
  try {
    const newRow = JSON.parse(raw) as Record<string, unknown>;
    const packageId = newRow.packageId as string;
    const runId = newRow.id as string;
    const status = newRow.status as string;
    const scheduleId = newRow.scheduleId as string | null;

    qc.setQueryData<EnrichedRun>(["run", orgId, applicationId, runId], (prev) => {
      if (!prev) return prev;
      return { ...prev, ...newRow } as EnrichedRun;
    });

    qc.setQueryData<EnrichedRun[]>(["runs", orgId, applicationId, packageId], (prev) => {
      if (!prev) return prev;
      const exists = prev.some((ex) => ex.id === runId);
      if (exists) {
        return prev.map((ex) => (ex.id === runId ? ({ ...ex, ...newRow } as EnrichedRun) : ex));
      }
      return [newRow as unknown as EnrichedRun, ...prev].slice(0, 50);
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
            } else if (event === "connection_update" && data) {
              handleConnectionUpdate(qcRef.current, orgId, applicationId);
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
