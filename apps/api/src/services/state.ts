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
    state?: Record<string, unknown>;
    error?: string;
    tokens_used?: number;
    completed_at?: string;
    duration?: number;
    token_usage?: Record<string, unknown>;
    cost_usd?: number;
  },
): Promise<void> {
  const { result, state, token_usage, ...rest } = updates;
  const { error } = await supabase
    .from("executions")
    .update({
      ...rest,
      ...(result !== undefined ? { result: result as Json } : {}),
      ...(state !== undefined ? { state: state as Json } : {}),
      ...(token_usage !== undefined ? { token_usage: token_usage as Json } : {}),
    })
    .eq("id", id);
  if (error) {
    logger.error("Failed to update execution", { executionId: id, error: error.message });
  }
}

export async function getLastExecutionState(
  flowId: string,
  userId: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .from("executions")
    .select("state")
    .eq("flow_id", flowId)
    .eq("user_id", userId)
    .not("state", "is", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .single();
  return (data?.state as Record<string, unknown>) ?? null;
}

export async function getRecentExecutions(
  flowId: string,
  userId: string,
  options: {
    limit?: number;
    fields?: ("state" | "result")[];
    excludeExecutionId?: string;
  } = {},
): Promise<Record<string, unknown>[]> {
  const limit = options.limit ?? 10;
  const fields = options.fields ?? ["state"];

  // Select all potentially needed columns (static string for Supabase typing)
  let query = supabase
    .from("executions")
    .select("id, status, started_at, duration, state, result")
    .eq("flow_id", flowId)
    .eq("user_id", userId)
    .eq("status", "success")
    .order("started_at", { ascending: false })
    .limit(limit);

  if (options.excludeExecutionId) {
    query = query.neq("id", options.excludeExecutionId);
  }

  const { data } = await query;
  return (data ?? []).map((row) => {
    const entry: Record<string, unknown> = {
      id: row.id,
      status: row.status,
      date: row.started_at,
      duration: row.duration,
    };
    if (fields.includes("state")) entry.state = row.state;
    if (fields.includes("result")) entry.result = row.result;
    return entry;
  });
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

// --- Admin Connections ---

export async function getAdminConnections(flowId: string): Promise<Record<string, string>> {
  const { data } = await supabase
    .from("flow_admin_connections")
    .select("service_id, admin_user_id")
    .eq("flow_id", flowId);
  const result: Record<string, string> = {};
  for (const row of data ?? []) {
    result[row.service_id] = row.admin_user_id;
  }
  return result;
}

export async function bindAdminConnection(
  flowId: string,
  serviceId: string,
  adminUserId: string,
): Promise<void> {
  const { error } = await supabase.from("flow_admin_connections").upsert(
    {
      flow_id: flowId,
      service_id: serviceId,
      admin_user_id: adminUserId,
      connected_at: new Date().toISOString(),
    },
    { onConflict: "flow_id,service_id" },
  );
  if (error) {
    throw new Error(`Failed to bind admin connection: ${error.message}`);
  }
}

export async function unbindAdminConnection(flowId: string, serviceId: string): Promise<void> {
  await supabase
    .from("flow_admin_connections")
    .delete()
    .eq("flow_id", flowId)
    .eq("service_id", serviceId);
}

export async function deleteAdminConnectionsForFlow(flowId: string): Promise<void> {
  await supabase.from("flow_admin_connections").delete().eq("flow_id", flowId);
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
