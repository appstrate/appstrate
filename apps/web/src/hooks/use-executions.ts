import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";

export function useExecutions(flowId: string | undefined) {
  return useQuery({
    queryKey: ["executions", flowId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("executions")
        .select("*")
        .eq("flow_id", flowId!)
        .order("started_at", { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);
      return data;
    },
    enabled: !!flowId,
  });
}

export function useExecution(execId: string | undefined) {
  return useQuery({
    queryKey: ["execution", execId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("executions")
        .select("*")
        .eq("id", execId!)
        .single();
      if (error) throw new Error(error.message);
      return data;
    },
    enabled: !!execId,
  });
}

export function useExecutionLogs(execId: string | undefined, running?: boolean) {
  return useQuery({
    queryKey: ["execution-logs", execId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("execution_logs")
        .select("*")
        .eq("execution_id", execId!)
        .order("id", { ascending: true });
      if (error) throw new Error(error.message);
      return data;
    },
    enabled: !!execId,
    refetchInterval: running ? 1000 : false,
  });
}
