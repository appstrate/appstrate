import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { useCurrentOrgId } from "./use-org";
import type { Execution } from "@appstrate/shared-types";
import type { RealtimeChannel } from "@supabase/supabase-js";

const TERMINAL_STATUSES = new Set(["success", "failed", "timeout"]);

/**
 * Global Realtime subscription on the `executions` table.
 * Syncs INSERT/UPDATE events directly into React Query cache via setQueryData,
 * avoiding full refetches. Mounted once at app level (inside OrgGate).
 */
export function useGlobalExecutionSync() {
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();

  useEffect(() => {
    if (!orgId) return;

    const channel: RealtimeChannel = supabase
      .channel("global-executions-sync")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "executions",
        },
        (payload) => {
          const newRow = payload.new as Execution;
          const flowId = newRow.flow_id;

          // Prepend into executions list cache (if it exists)
          qc.setQueryData<Execution[]>(["executions", orgId, flowId], (prev) => {
            if (!prev) return prev;
            if (prev.some((e) => e.id === newRow.id)) return prev;
            return [newRow, ...prev].slice(0, 50);
          });

          // Invalidate flow list & detail (runningExecutions count changes)
          qc.invalidateQueries({ queryKey: ["flows", orgId] });
          qc.invalidateQueries({ queryKey: ["flow", orgId, flowId] });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "executions",
        },
        (payload) => {
          const newRow = payload.new as Execution;
          const flowId = newRow.flow_id;

          // Update single execution cache
          qc.setQueryData<Execution>(["execution", orgId, newRow.id], (prev) => {
            if (!prev) return prev;
            return { ...prev, ...newRow };
          });

          // Update execution in list cache
          qc.setQueryData<Execution[]>(["executions", orgId, flowId], (prev) => {
            if (!prev) return prev;
            return prev.map((e) => (e.id === newRow.id ? { ...e, ...newRow } : e));
          });

          // On terminal status, invalidate flows (runningExecutions count changes)
          if (TERMINAL_STATUSES.has(newRow.status)) {
            qc.invalidateQueries({ queryKey: ["flows", orgId] });
            qc.invalidateQueries({ queryKey: ["flow", orgId, flowId] });
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc, orgId]);
}
