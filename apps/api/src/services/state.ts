import { supabase } from "../lib/supabase.ts";
import { logger } from "../lib/logger.ts";
import type { Json } from "../types/index.ts";

// --- Flow Config (global, no user_id) ---

export async function getFlowConfig(flowId: string): Promise<Record<string, unknown>> {
  const { data } = await supabase
    .from("flow_configs")
    .select("config")
    .eq("flow_id", flowId)
    .single();
  return (data?.config ?? {}) as Record<string, unknown>;
}

export async function setFlowConfig(
  flowId: string,
  config: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from("flow_configs")
    .upsert(
      { flow_id: flowId, config: config as Json, updated_at: new Date().toISOString() },
      { onConflict: "flow_id" },
    );
  if (error) {
    throw new Error(`Failed to save config for flow ${flowId}: ${error.message}`);
  }
}

// --- Flow State (per-user) ---

export async function getFlowState(
  userId: string,
  flowId: string,
): Promise<Record<string, unknown>> {
  const { data } = await supabase
    .from("flow_state")
    .select("state")
    .eq("user_id", userId)
    .eq("flow_id", flowId)
    .single();
  return (data?.state ?? {}) as Record<string, unknown>;
}

export async function deleteFlowState(userId: string, flowId: string): Promise<void> {
  await supabase.from("flow_state").delete().eq("user_id", userId).eq("flow_id", flowId);
}

export async function setFlowState(
  userId: string,
  flowId: string,
  state: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from("flow_state").upsert(
    {
      user_id: userId,
      flow_id: flowId,
      state: state as Json,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,flow_id" },
  );
  if (error) {
    throw new Error(`Failed to save state for flow ${flowId}: ${error.message}`);
  }
}

// --- Executions ---

export async function createExecution(
  id: string,
  flowId: string,
  userId: string,
  input: Record<string, unknown> | null,
  scheduleId?: string,
  flowVersionId?: number,
): Promise<void> {
  const { error } = await supabase.from("executions").insert({
    id,
    flow_id: flowId,
    user_id: userId,
    status: "pending",
    input: input as Json,
    started_at: new Date().toISOString(),
    schedule_id: scheduleId ?? null,
    flow_version_id: flowVersionId ?? null,
  });
  if (error) {
    throw new Error(`Failed to create execution ${id}: ${error.message}`);
  }
}

export async function updateExecution(
  id: string,
  updates: {
    status?: string;
    result?: Record<string, unknown>;
    error?: string;
    tokens_used?: number;
    completed_at?: string;
    duration?: number;
  },
): Promise<void> {
  const { result, ...rest } = updates;
  const { error } = await supabase
    .from("executions")
    .update({ ...rest, ...(result !== undefined ? { result: result as Json } : {}) })
    .eq("id", id);
  if (error) {
    logger.error("Failed to update execution", { executionId: id, error: error.message });
  }
}

export async function getLastExecution(flowId: string, userId: string) {
  const { data } = await supabase
    .from("executions")
    .select("id, status, started_at, duration")
    .eq("flow_id", flowId)
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(1)
    .single();
  return data ?? null;
}

export async function appendExecutionLog(
  executionId: string,
  userId: string,
  type: string,
  event: string | null,
  message: string | null,
  data: Record<string, unknown> | null,
): Promise<number> {
  const { data: row, error } = await supabase
    .from("execution_logs")
    .insert({
      execution_id: executionId,
      user_id: userId,
      type,
      event,
      message,
      data: data as Json,
    })
    .select("id")
    .single();
  if (error) {
    logger.error("Failed to append execution log", { executionId, error: error.message });
    return 0;
  }
  return row?.id ?? 0;
}

export async function getRunningExecutionsForFlow(
  flowId: string,
  userId?: string,
): Promise<number> {
  let query = supabase
    .from("executions")
    .select("id", { count: "exact", head: true })
    .eq("flow_id", flowId)
    .in("status", ["running", "pending"]);

  if (userId) {
    query = query.eq("user_id", userId);
  }

  const { count } = await query;
  return count ?? 0;
}

export async function getRunningExecutionsCounts(userId?: string): Promise<Record<string, number>> {
  let query = supabase.from("executions").select("flow_id").in("status", ["running", "pending"]);

  if (userId) {
    query = query.eq("user_id", userId);
  }

  const { data } = await query;
  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    const flowId = row.flow_id;
    counts[flowId] = (counts[flowId] ?? 0) + 1;
  }
  return counts;
}

export async function markOrphanExecutionsFailed(): Promise<number> {
  const { data } = await supabase
    .from("executions")
    .update({
      status: "failed",
      error: "Server restarted",
      completed_at: new Date().toISOString(),
    })
    .in("status", ["running", "pending"])
    .select("id");
  return data?.length ?? 0;
}
