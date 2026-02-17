import { supabase } from "../lib/supabase.ts";
import { logger } from "../lib/logger.ts";
import { uploadFlowPackage } from "./flow-package.ts";

export interface FlowVersion {
  id: number;
  flow_id: string;
  version_number: number;
  created_by: string | null;
  created_at: string | null;
}

/** Create a new version snapshot for a user flow. Returns the version row ID. */
export async function createFlowVersion(flowId: string, createdBy: string): Promise<number | null> {
  const { data, error } = await supabase.rpc("create_flow_version", {
    p_flow_id: flowId,
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
    .select("id, flow_id, version_number, created_by, created_at")
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

/**
 * Create a version snapshot and upload the ZIP to Storage in one call.
 * Non-blocking: logs errors but never throws.
 */
export async function createVersionAndUpload(
  flowId: string,
  createdBy: string,
  zipBuffer: Buffer,
): Promise<void> {
  const versionId = await createFlowVersion(flowId, createdBy);
  if (versionId !== null) {
    const versionNumber = await getLatestVersionNumber(flowId);
    await uploadFlowPackage(flowId, versionNumber, zipBuffer);
  }
}

/** Get the latest version number for a flow. */
async function getLatestVersionNumber(flowId: string): Promise<number> {
  const { data } = await supabase
    .from("flow_versions")
    .select("version_number")
    .eq("flow_id", flowId)
    .order("version_number", { ascending: false })
    .limit(1)
    .single();

  return data?.version_number ?? 0;
}
