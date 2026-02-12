import { useEffect, useRef, useCallback } from "react";
import { supabase } from "../lib/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

/**
 * Subscribe to execution status changes via Supabase Realtime.
 * Logs are fetched via polling (Realtime doesn't deliver execution_logs INSERTs
 * reliably due to the subquery-based RLS policy on that table).
 */
export function useExecutionRealtime(
  executionId: string | null | undefined,
  onStatusChange?: (payload: Record<string, unknown>) => void,
) {
  const onStatusRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusRef.current = onStatusChange;
  });

  useEffect(() => {
    if (!executionId) return;

    const channel: RealtimeChannel = supabase
      .channel(`exec-${executionId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "executions",
          filter: `id=eq.${executionId}`,
        },
        (payload) => {
          onStatusRef.current?.(payload.new as Record<string, unknown>);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [executionId]);
}

/**
 * Subscribe to execution status changes for a specific flow (e.g. running count updates).
 */
export function useFlowExecutionRealtime(flowId: string | null | undefined, callback: () => void) {
  const cbRef = useRef(callback);
  useEffect(() => {
    cbRef.current = callback;
  });

  useEffect(() => {
    if (!flowId) return;

    const channel: RealtimeChannel = supabase
      .channel(`flow-exec-${flowId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "executions",
          filter: `flow_id=eq.${flowId}`,
        },
        () => {
          cbRef.current();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [flowId]);
}

/**
 * Subscribe to all execution status changes (for flow list running counts).
 */
export function useAllExecutionsRealtime(callback: () => void) {
  const cbRef = useRef(callback);
  useEffect(() => {
    cbRef.current = callback;
  });

  const stableCallback = useCallback(() => cbRef.current(), []);

  useEffect(() => {
    const channel: RealtimeChannel = supabase
      .channel("all-executions")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "executions",
        },
        () => {
          stableCallback();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [stableCallback]);
}
