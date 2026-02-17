import { supabase } from "../lib/supabase.ts";
import { deleteFlowPackage } from "./flow-package.ts";
import type { FlowRow, Json } from "@appstrate/shared-types";

export type { FlowRow };

export async function getFlowById(id: string): Promise<FlowRow | null> {
  const { data } = await supabase.from("flows").select("*").eq("id", id).single();
  return data ?? null;
}

export async function insertUserFlow(
  id: string,
  manifest: Record<string, unknown>,
  prompt: string,
): Promise<FlowRow> {
  const { data, error } = await supabase
    .from("flows")
    .insert({
      id,
      manifest: manifest as Json,
      prompt,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateUserFlow(
  id: string,
  payload: {
    manifest: Record<string, unknown>;
    prompt: string;
  },
  expectedUpdatedAt: string,
): Promise<FlowRow | null> {
  const updatePayload: Record<string, unknown> = {
    manifest: payload.manifest as Json,
    prompt: payload.prompt,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("flows")
    .update(updatePayload)
    .eq("id", id)
    .eq("updated_at", expectedUpdatedAt)
    .select()
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // 0 rows matched = stale
    throw error;
  }
  return data;
}

export async function deleteUserFlow(id: string): Promise<void> {
  // execution_logs cascade-deleted via executions FK
  await supabase.from("executions").delete().eq("flow_id", id);
  await supabase.from("flow_schedules").delete().eq("flow_id", id);
  await supabase.from("flow_configs").delete().eq("flow_id", id);
  await supabase.from("flow_state").delete().eq("flow_id", id);
  await supabase.from("flow_versions").delete().eq("flow_id", id);
  await supabase.from("flow_admin_connections").delete().eq("flow_id", id);
  await supabase.from("flows").delete().eq("id", id);

  // Remove flow package from Storage
  await deleteFlowPackage(id);
}
