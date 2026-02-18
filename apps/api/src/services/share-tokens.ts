import crypto from "node:crypto";
import { supabase } from "../lib/supabase.ts";

const DEFAULT_EXPIRES_DAYS = 7;

export async function createShareToken(
  flowId: string,
  createdBy: string,
  expiresInDays = DEFAULT_EXPIRES_DAYS,
) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("share_tokens")
    .insert({ token, flow_id: flowId, created_by: createdBy, expires_at: expiresAt })
    .select()
    .single();

  if (error) throw new Error(`Failed to create share token: ${error.message}`);
  return data!;
}

export async function getShareToken(token: string) {
  const { data } = await supabase
    .from("share_tokens")
    .select("*")
    .eq("token", token)
    .single();
  return data ?? null;
}

export async function consumeShareToken(token: string) {
  const { data } = await supabase.rpc("consume_share_token", { p_token: token });
  if (!data || (Array.isArray(data) && data.length === 0)) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return row as { id: string; flow_id: string; created_by: string };
}

export async function linkExecutionToToken(tokenId: string, executionId: string) {
  const { error } = await supabase
    .from("share_tokens")
    .update({ execution_id: executionId })
    .eq("id", tokenId);
  if (error) throw new Error(`Failed to link execution to token: ${error.message}`);
}
