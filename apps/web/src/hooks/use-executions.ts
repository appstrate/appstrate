import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { useCurrentOrgId } from "./use-org";

export function useExecutions(flowId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["executions", orgId, flowId],
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
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["execution", orgId, execId],
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

export function useExecutionLogs(execId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["execution-logs", orgId, execId],
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
  });
}
