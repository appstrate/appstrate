import { supabase } from "../lib/supabase.ts";
import { logger } from "../lib/logger.ts";
import type { Json } from "../types/index.ts";

export interface FlowVersion {
  id: number;
  flow_id: string;
  version_number: number;
  manifest: unknown;
  prompt: string;
  skills: unknown;
  created_by: string | null;
  created_at: string | null;
}

/** Create a new version snapshot for a user flow. Returns the version row ID. */
export async function createFlowVersion(
  flowId: string,
  manifest: Record<string, unknown>,
  prompt: string,
  skills: { id: string; description: string; content: string }[],
  createdBy: string,
): Promise<number | null> {
  const { data, error } = await supabase.rpc("create_flow_version", {
    p_flow_id: flowId,
    p_manifest: manifest as Json,
    p_prompt: prompt,
    p_skills: (skills ?? []) as unknown as Json,
    p_created_by: createdBy,
  });

  if (error) {
    logger.error("Failed to create flow version", { flowId, error: error.message });
    return null;
  }

  return data as number;
}

/** List all versions for a flow, newest first. */
export async function listFlowVersions(flowId: string): Promise<FlowVersion[]> {
  const { data, error } = await supabase
    .from("flow_versions")
    .select("*")
    .eq("flow_id", flowId)
    .order("version_number", { ascending: false });

  if (error) {
    logger.error("Failed to list flow versions", { flowId, error: error.message });
    return [];
  }

  return data as FlowVersion[];
}

/** Get the latest version ID for a flow (used to tag executions). */
export async function getLatestVersionId(flowId: string): Promise<number | null> {
  const { data } = await supabase
    .from("flow_versions")
    .select("id")
    .eq("flow_id", flowId)
    .order("version_number", { ascending: false })
    .limit(1)
    .single();

  return data?.id ?? null;
}
