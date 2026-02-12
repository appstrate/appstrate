import { supabase } from "../lib/supabase.ts";
import type { Tables, Json } from "@appstrate/shared-types";

export type UserFlowRow = Tables<"user_flows">;

export async function listUserFlows(): Promise<UserFlowRow[]> {
  const { data } = await supabase
    .from("user_flows")
    .select("*")
    .order("created_at", { ascending: false });
  return data ?? [];
}

export async function getUserFlow(id: string): Promise<UserFlowRow | null> {
  const { data } = await supabase.from("user_flows").select("*").eq("id", id).single();
  return data ?? null;
}

export async function userFlowExists(id: string): Promise<boolean> {
  const { data } = await supabase.from("user_flows").select("id").eq("id", id).limit(1).single();
  return !!data;
}

export async function insertUserFlow(
  id: string,
  manifest: Record<string, unknown>,
  prompt: string,
  skills: { id: string; description: string; content: string }[],
): Promise<void> {
  await supabase
    .from("user_flows")
    .insert({ id, manifest: manifest as Json, prompt, skills: skills as unknown as Json });
}

export async function deleteUserFlow(id: string): Promise<void> {
  // execution_logs cascade-deleted via executions FK
  await supabase.from("executions").delete().eq("flow_id", id);
  await supabase.from("flow_schedules").delete().eq("flow_id", id);
  await supabase.from("flow_configs").delete().eq("flow_id", id);
  await supabase.from("flow_state").delete().eq("flow_id", id);
  await supabase.from("user_flows").delete().eq("id", id);
}
