import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCurrentOrgId } from "./use-org";
import type { Execution } from "@appstrate/shared-types";

const TERMINAL_STATUSES = new Set(["success", "failed", "timeout"]);

/**
 * Global SSE subscription on execution changes.
 * Syncs INSERT/UPDATE events directly into React Query cache via setQueryData,
 * avoiding full refetches. Mounted once at app level (inside OrgGate).
 */
export function useGlobalExecutionSync() {
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();

  useEffect(() => {
    if (!orgId) return;

    const es = new EventSource(`/api/realtime/executions?orgId=${encodeURIComponent(orgId)}`, {
      withCredentials: true,
    });

    es.addEventListener("execution_update", (e) => {
      try {
        const newRow = JSON.parse(e.data) as Record<string, unknown>;
        const flowId = newRow.flowId as string;
        const execId = newRow.id as string;
        const status = newRow.status as string;

        // Update single execution cache
        qc.setQueryData<Execution>(["execution", orgId, execId], (prev) => {
          if (!prev) return prev;
          return { ...prev, ...newRow } as Execution;
        });

        // Update execution in list cache
        qc.setQueryData<Execution[]>(["executions", orgId, flowId], (prev) => {
          if (!prev) return prev;
          const exists = prev.some((ex) => ex.id === execId);
          if (exists) {
            return prev.map((ex) => (ex.id === execId ? ({ ...ex, ...newRow } as Execution) : ex));
          }
          // New execution — prepend
          return [newRow as Execution, ...prev].slice(0, 50);
        });

        // On terminal status, invalidate flows (runningExecutions count changes)
        if (TERMINAL_STATUSES.has(status)) {
          qc.invalidateQueries({ queryKey: ["flows", orgId] });
          qc.invalidateQueries({ queryKey: ["flow", orgId, flowId] });
        }

        // On new execution (status pending/running), also invalidate flows
        if (status === "pending" || status === "running") {
          qc.invalidateQueries({ queryKey: ["flows", orgId] });
          qc.invalidateQueries({ queryKey: ["flow", orgId, flowId] });
        }
      } catch {
        // Ignore malformed SSE payloads
      }
    });

    // Prevent native auto-reconnect loop (Safari aggressively reconnects on failure)
    es.onerror = () => {
      console.warn("[SSE] realtime connection failed, closing");
      es.close();
    };

    return () => {
      es.close();
    };
  }, [qc, orgId]);
}
