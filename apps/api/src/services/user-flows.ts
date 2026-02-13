import { supabase } from "../lib/supabase.ts";
import type { FlowRow, Json } from "@appstrate/shared-types";

export type { FlowRow };

export async function listUserFlows(): Promise<FlowRow[]> {
  const { data } = await supabase
    .from("flows")
    .select("*")
    .eq("source", "user")
    .order("created_at", { ascending: false });
  return data ?? [];
}

export async function getFlowById(id: string): Promise<FlowRow | null> {
  const { data } = await supabase.from("flows").select("*").eq("id", id).single();
  return data ?? null;
}

export async function userFlowExists(id: string): Promise<boolean> {
  const { data } = await supabase.from("flows").select("id").eq("id", id).limit(1).single();
  return !!data;
}

export async function insertUserFlow(
  id: string,
  manifest: Record<string, unknown>,
  prompt: string,
  skills: { id: string; description: string; content: string }[],
): Promise<FlowRow> {
  const { data, error } = await supabase
    .from("flows")
    .insert({
      id,
      manifest: manifest as Json,
      prompt,
      skills: skills as unknown as Json,
      source: "user",
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
    skills: { id: string; description: string; content: string }[];
  },
  expectedUpdatedAt: string,
): Promise<FlowRow | null> {
  const { data, error } = await supabase
    .from("flows")
    .update({
      manifest: payload.manifest as Json,
      prompt: payload.prompt,
      skills: payload.skills as unknown as Json,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("source", "user")
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
  await supabase.from("flows").delete().eq("id", id).eq("source", "user");
}
