import { eq, desc, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { flowVersions } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { uploadFlowPackage } from "./flow-package.ts";

interface FlowVersionEntry {
  id: number;
  flowId: string;
  versionNumber: number;
  createdBy: string | null;
  createdAt: string | null;
}

/** Create a new version snapshot for a user flow. Returns the version row ID. */
export async function createFlowVersion(flowId: string, createdBy: string): Promise<number | null> {
  try {
    const result = await db.transaction(async (tx) => {
      // Get max version number
      const [maxRow] = await tx
        .select({ maxVersion: sql<number>`COALESCE(MAX(${flowVersions.versionNumber}), 0)` })
        .from(flowVersions)
        .where(eq(flowVersions.flowId, flowId));

      const nextVersion = (maxRow?.maxVersion ?? 0) + 1;

      const [row] = await tx
        .insert(flowVersions)
        .values({
          flowId,
          versionNumber: nextVersion,
          createdBy,
        })
        .returning({ id: flowVersions.id });

      return row!.id;
    });

    return result;
  } catch (err) {
    logger.error("Failed to create flow version", {
      flowId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** List all versions for a flow, newest first. */
export async function listFlowVersions(flowId: string): Promise<FlowVersionEntry[]> {
  try {
    const rows = await db
      .select()
      .from(flowVersions)
      .where(eq(flowVersions.flowId, flowId))
      .orderBy(desc(flowVersions.versionNumber));

    return rows.map((r) => ({
      id: r.id,
      flowId: r.flowId,
      versionNumber: r.versionNumber,
      createdBy: r.createdBy,
      createdAt: r.createdAt?.toISOString() ?? null,
    }));
  } catch (err) {
    logger.error("Failed to list flow versions", {
      flowId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Get the latest version ID for a flow (used to tag executions). */
export async function getLatestVersionId(flowId: string): Promise<number | null> {
  const rows = await db
    .select({ id: flowVersions.id })
    .from(flowVersions)
    .where(eq(flowVersions.flowId, flowId))
    .orderBy(desc(flowVersions.versionNumber))
    .limit(1);

  return rows[0]?.id ?? null;
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
  const rows = await db
    .select({ versionNumber: flowVersions.versionNumber })
    .from(flowVersions)
    .where(eq(flowVersions.flowId, flowId))
    .orderBy(desc(flowVersions.versionNumber))
    .limit(1);

  return rows[0]?.versionNumber ?? 0;
}
