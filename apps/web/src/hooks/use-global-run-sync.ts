// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { invalidateIntegrationQueries } from "./use-integrations";
import { invalidateNotificationQueries } from "./use-notifications";
import { parseSSEFrames } from "../lib/sse-parser";
import {
  runKeys,
  runsKeys,
  paginatedRunsKeys,
  packageKeys,
  agentsKeys,
  scheduleKeys,
  billingKeys,
} from "../lib/query-keys";
import {
  type EnrichedRun,
  TERMINAL_RUN_STATUSES,
  runUpdateEventSchema,
  runUpdateToRunPatch,
} from "@appstrate/shared-types";

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
function handleConnectionUpdate(qc: QueryClient) {
  // Connections page (`/preferences/connections`) — the orange
  // "Reconnection required" badge reads off this typed query.
  qc.invalidateQueries({ queryKey: ["get", "/api/me/connections"] });
  // Integration list (sidebar status, integrations page count) +
  // detail subtree (auth statuses, connection lists, agent-resolution
  // verdicts, the resolution verdict that powers the agent picker
  // dropdown). The typed keys are `[method, "/api/integrations…", init]`,
  // so the shared helper matches on the path element.
  void invalidateIntegrationQueries(qc);
}

/**
 * Trailing debounce (~2s) for the BROAD query invalidations triggered by
 * `run_update` events. A running agent emits frequent updates; the run/runs
 * caches are already patched in place (cheap), but invalidating
 * `["agents"]` / `["packages"]` / `["paginated-runs"]` on every event caused
 * a refetch fan-out per SSE message. Collapsing bursts into one trailing
 * flush keeps lists fresh at a fraction of the request volume.
 */
interface BroadInvalidator {
  schedule: (key: readonly unknown[]) => void;
  dispose: () => void;
}

function createBroadInvalidator(
  getQueryClient: () => QueryClient,
  delayMs = 2000,
): BroadInvalidator {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<string, readonly unknown[]>();

  const flush = () => {
    timer = null;
    const qc = getQueryClient();
    for (const key of pending.values()) {
      qc.invalidateQueries({ queryKey: key as unknown[] });
    }
    pending.clear();
  };

  return {
    schedule(key) {
      pending.set(JSON.stringify(key), key);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}

function handleSSEMessage(
  qc: QueryClient,
  broad: BroadInvalidator,
  orgId: string,
  applicationId: string,
  raw: string,
) {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return; // malformed frame
  }
  const parsed = runUpdateEventSchema.safeParse(json);
  if (!parsed.success) return;
  const evt = parsed.data;
  const { id: runId, packageId, status, scheduleId } = evt;
  // Map the camelCase wire frame onto RunWireDto field names (started_at /
  // completed_at are snake there) so the spread actually overwrites them.
  const patch = runUpdateToRunPatch(evt);

  qc.setQueryData<EnrichedRun>(runKeys.detail(orgId, applicationId, runId), (prev) =>
    prev ? { ...prev, ...patch } : prev,
  );

  // Only the per-agent run list is keyed by packageId (nullable on the wire
  // once a run's package is deleted — ON DELETE SET NULL).
  if (packageId) {
    const listKey = runsKeys.forAgent(orgId, applicationId, packageId);
    const list = qc.getQueryData<EnrichedRun[]>(listKey);
    if (list) {
      if (list.some((ex) => ex.id === runId)) {
        qc.setQueryData<EnrichedRun[]>(listKey, (prev) =>
          prev?.map((ex) => (ex.id === runId ? { ...ex, ...patch } : ex)),
        );
      } else {
        // A run not yet in this list (its first event) — refetch the full
        // enriched row instead of inserting a 13-field partial as a full one.
        qc.invalidateQueries({ queryKey: listKey });
      }
    }
  }

  // Broad invalidations are debounced (trailing ~2s) — the in-place cache
  // patches above keep the visible run data live in the meantime.
  broad.schedule(agentsKeys.inOrg(orgId));
  // Agent detail caches are keyed ["packages","agents",orgId,applicationId,id]
  // (plural path, applicationId before id) — invalidate by the org-scoped
  // prefix so a run status change refreshes the agent's config/model tabs.
  broad.schedule(packageKeys.familyInOrg("agents", orgId));
  broad.schedule(paginatedRunsKeys.all);

  // Invalidate schedule-specific caches
  if (scheduleId) {
    qc.invalidateQueries({ queryKey: scheduleKeys.runs(orgId, applicationId, scheduleId) });
    qc.invalidateQueries({ queryKey: scheduleKeys.detail(orgId, applicationId, scheduleId) });
    qc.invalidateQueries({ queryKey: scheduleKeys.list(orgId, applicationId) });
  }

  if (TERMINAL_RUN_STATUSES.has(status)) {
    // NOTE: ["paginated-runs"] is NOT invalidated here — the debounced
    // broad invalidation above already covers it for this same event
    // (it used to be invalidated twice per terminal run).
    invalidateNotificationQueries(qc);
    qc.invalidateQueries({ queryKey: runsKeys.all });
    qc.invalidateQueries({ queryKey: runKeys.all });
    qc.invalidateQueries({ queryKey: billingKeys.forOrg(orgId) });
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
    const broad = createBroadInvalidator(() => qcRef.current);

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

          const { frames, buffer } = parseSSEFrames(decoder.decode(value, { stream: true }), buf);
          buf = buffer;

          for (const { event, data } of frames) {
            if (event === "run_update" && data) {
              handleSSEMessage(qcRef.current, broad, orgId, applicationId, data);
            } else if (event === "connection_update" && data) {
              handleConnectionUpdate(qcRef.current);
            }
          }
        }
      } catch {
        // Connection failed or aborted — no auto-reconnect
      }
    })();

    return () => {
      controller.abort();
      broad.dispose();
    };
  }, [orgId, applicationId]);
}
