import { useEffect, useRef, useCallback } from "react";
import { supabase } from "../lib/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

/**
 * Subscribe to new execution_logs rows and execution status changes for an execution.
 */
export function useExecutionRealtime(
  executionId: string | null | undefined,
  callbacks: {
    onLog?: (payload: Record<string, unknown>) => void;
    onStatusChange?: (payload: Record<string, unknown>) => void;
  },
) {
  const onLogRef = useRef(callbacks.onLog);
  const onStatusRef = useRef(callbacks.onStatusChange);
  useEffect(() => {
    onLogRef.current = callbacks.onLog;
    onStatusRef.current = callbacks.onStatusChange;
  });

  useEffect(() => {
    if (!executionId) return;

    const channel: RealtimeChannel = supabase
      .channel(`exec-${executionId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "execution_logs",
          filter: `execution_id=eq.${executionId}`,
        },
        (payload) => {
          onLogRef.current?.(payload.new as Record<string, unknown>);
        },
      )
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
