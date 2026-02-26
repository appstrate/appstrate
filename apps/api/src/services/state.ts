import { eq, and, ne, desc, asc, isNotNull, inArray, count } from "drizzle-orm";
import { db } from "../lib/db.ts";
import {
  flowConfigs,
  executions,
  executionLogs,
  flowAdminConnections,
  flowMemories,
} from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";

// --- Flow Config (per-org) ---

export async function getFlowConfig(
  orgId: string,
  flowId: string,
): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ config: flowConfigs.config })
    .from(flowConfigs)
    .where(and(eq(flowConfigs.orgId, orgId), eq(flowConfigs.flowId, flowId)))
    .limit(1);
  return (row?.config ?? {}) as Record<string, unknown>;
}

export async function setFlowConfig(
  orgId: string,
  flowId: string,
  config: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(flowConfigs)
    .values({
      orgId,
      flowId,
      config,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [flowConfigs.orgId, flowConfigs.flowId],
      set: {
        config,
        updatedAt: new Date(),
      },
    });
}

// --- Executions ---

export async function createExecution(
  id: string,
  flowId: string,
  userId: string,
  orgId: string,
  input: Record<string, unknown> | null,
  scheduleId?: string,
  flowVersionId?: number,
  connectionProfileId?: string,
): Promise<void> {
  await db.insert(executions).values({
    id,
    flowId,
    userId,
    orgId,
    status: "pending",
    input,
    startedAt: new Date(),
    connectionProfileId: connectionProfileId ?? null,
    scheduleId: scheduleId ?? null,
    flowVersionId: flowVersionId ?? null,
  });
}

export async function updateExecution(
  id: string,
  updates: {
    status?: string;
    result?: Record<string, unknown>;
    state?: Record<string, unknown>;
    error?: string;
    tokensUsed?: number;
    completedAt?: string;
    duration?: number;
    tokenUsage?: Record<string, unknown>;
    costUsd?: number;
  },
): Promise<void> {
  const set: Record<string, unknown> = {};

  if (updates.status !== undefined) set.status = updates.status;
  if (updates.error !== undefined) set.error = updates.error;
  if (updates.tokensUsed !== undefined) set.tokensUsed = updates.tokensUsed;
  if (updates.completedAt !== undefined) set.completedAt = new Date(updates.completedAt);
  if (updates.duration !== undefined) set.duration = updates.duration;
  if (updates.result !== undefined) set.result = updates.result;
  if (updates.state !== undefined) set.state = updates.state;
  if (updates.tokenUsage !== undefined) set.tokenUsage = updates.tokenUsage;
  if (updates.costUsd !== undefined) set.costUsd = String(updates.costUsd);

  try {
    await db.update(executions).set(set).where(eq(executions.id, id));
  } catch (err) {
    logger.error("Failed to update execution", {
      executionId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function getLastExecutionState(
  flowId: string,
  userId: string,
  orgId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ state: executions.state })
    .from(executions)
    .where(
      and(
        eq(executions.flowId, flowId),
        eq(executions.userId, userId),
        eq(executions.orgId, orgId),
        isNotNull(executions.state),
      ),
    )
    .orderBy(desc(executions.startedAt))
    .limit(1);
  return (row?.state as Record<string, unknown>) ?? null;
}

export async function getRecentExecutions(
  flowId: string,
  userId: string,
  orgId: string,
  options: {
    limit?: number;
    fields?: ("state" | "result")[];
    excludeExecutionId?: string;
  } = {},
): Promise<Record<string, unknown>[]> {
  const limit = options.limit ?? 10;
  const fields = options.fields ?? ["state"];

  const conditions = [
    eq(executions.flowId, flowId),
    eq(executions.userId, userId),
    eq(executions.orgId, orgId),
    eq(executions.status, "success"),
  ];

  if (options.excludeExecutionId) {
    conditions.push(ne(executions.id, options.excludeExecutionId));
  }

  const rows = await db
    .select({
      id: executions.id,
      status: executions.status,
      startedAt: executions.startedAt,
      duration: executions.duration,
      state: executions.state,
      result: executions.result,
    })
    .from(executions)
    .where(and(...conditions))
    .orderBy(desc(executions.startedAt))
    .limit(limit);

  return rows.map((row) => {
    const entry: Record<string, unknown> = {
      id: row.id,
      status: row.status,
      date: row.startedAt?.toISOString() ?? null,
      duration: row.duration,
    };
    if (fields.includes("state")) entry.state = row.state;
    if (fields.includes("result")) entry.result = row.result;
    return entry;
  });
}

export async function getLastExecution(flowId: string, userId: string, orgId: string) {
  const [row] = await db
    .select({
      id: executions.id,
      status: executions.status,
      startedAt: executions.startedAt,
      duration: executions.duration,
    })
    .from(executions)
    .where(
      and(
        eq(executions.flowId, flowId),
        eq(executions.userId, userId),
        eq(executions.orgId, orgId),
      ),
    )
    .orderBy(desc(executions.startedAt))
    .limit(1);
  return row ?? null;
}

export async function appendExecutionLog(
  executionId: string,
  userId: string,
  orgId: string,
  type: string,
  event: string | null,
  message: string | null,
  data: Record<string, unknown> | null,
): Promise<number> {
  try {
    const [row] = await db
      .insert(executionLogs)
      .values({
        executionId,
        userId,
        orgId,
        type,
        event,
        message,
        data,
      })
      .returning({ id: executionLogs.id });
    return row?.id ?? 0;
  } catch (err) {
    logger.error("Failed to append execution log", {
      executionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

export async function getRunningExecutionsForFlow(
  flowId: string,
  userId?: string,
): Promise<number> {
  const conditions = [
    eq(executions.flowId, flowId),
    inArray(executions.status, ["running", "pending"]),
  ];

  if (userId) {
    conditions.push(eq(executions.userId, userId));
  }

  const [row] = await db
    .select({ count: count() })
    .from(executions)
    .where(and(...conditions));
  return row?.count ?? 0;
}

export async function getRunningExecutionsCounts(orgId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ flowId: executions.flowId, count: count() })
    .from(executions)
    .where(and(eq(executions.orgId, orgId), inArray(executions.status, ["running", "pending"])))
    .groupBy(executions.flowId);

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.flowId] = row.count;
  }
  return counts;
}

// --- Admin Connections (per-org) ---

export async function getAdminConnections(
  orgId: string,
  flowId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({
      serviceId: flowAdminConnections.serviceId,
      profileId: flowAdminConnections.profileId,
    })
    .from(flowAdminConnections)
    .where(and(eq(flowAdminConnections.orgId, orgId), eq(flowAdminConnections.flowId, flowId)));
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (row.profileId) {
      result[row.serviceId] = row.profileId;
    }
  }
  return result;
}

export async function bindAdminConnection(
  orgId: string,
  flowId: string,
  serviceId: string,
  profileId: string,
): Promise<void> {
  await db
    .insert(flowAdminConnections)
    .values({
      orgId,
      flowId,
      serviceId,
      profileId,
      connectedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [flowAdminConnections.flowId, flowAdminConnections.serviceId],
      set: {
        orgId,
        profileId,
        connectedAt: new Date(),
      },
    });
}

export async function unbindAdminConnection(
  orgId: string,
  flowId: string,
  serviceId: string,
): Promise<void> {
  await db
    .delete(flowAdminConnections)
    .where(
      and(
        eq(flowAdminConnections.orgId, orgId),
        eq(flowAdminConnections.flowId, flowId),
        eq(flowAdminConnections.serviceId, serviceId),
      ),
    );
}

// Custom service credentials functions removed --- now handled by @appstrate/connect
// via connection-manager.ts. The custom_service_credentials table has been
// migrated to service_connections (migration 012).

export async function getExecution(id: string) {
  const [row] = await db
    .select({
      id: executions.id,
      status: executions.status,
      userId: executions.userId,
      orgId: executions.orgId,
      flowId: executions.flowId,
    })
    .from(executions)
    .where(eq(executions.id, id))
    .limit(1);
  return row ?? null;
}

export async function deleteFlowExecutions(flowId: string, orgId: string): Promise<number> {
  const deleted = await db
    .delete(executions)
    .where(and(eq(executions.flowId, flowId), eq(executions.orgId, orgId)))
    .returning({ id: executions.id });
  return deleted.length;
}

export async function listFlowExecutions(flowId: string, orgId: string, limit = 50) {
  return db
    .select()
    .from(executions)
    .where(and(eq(executions.flowId, flowId), eq(executions.orgId, orgId)))
    .orderBy(desc(executions.startedAt))
    .limit(limit);
}

export async function getExecutionFull(id: string) {
  const [row] = await db.select().from(executions).where(eq(executions.id, id)).limit(1);
  return row ?? null;
}

export async function listExecutionLogs(executionId: string, orgId: string) {
  return db
    .select()
    .from(executionLogs)
    .where(and(eq(executionLogs.executionId, executionId), eq(executionLogs.orgId, orgId)))
    .orderBy(executionLogs.id);
}

export async function markOrphanExecutionsFailed(): Promise<{
  count: number;
  executionIds: string[];
}> {
  const updated = await db
    .update(executions)
    .set({
      status: "failed",
      error: "Server restarted while execution was in progress. Please retry.",
      completedAt: new Date(),
    })
    .where(inArray(executions.status, ["running", "pending"]))
    .returning({ id: executions.id });
  return { count: updated.length, executionIds: updated.map((r) => r.id) };
}

// --- Flow Memories (org-scoped, accumulate across executions) ---

const MAX_MEMORY_CONTENT = 2000;
const MAX_MEMORIES_PER_FLOW = 100;

export async function getFlowMemories(flowId: string, orgId: string) {
  return db
    .select()
    .from(flowMemories)
    .where(and(eq(flowMemories.flowId, flowId), eq(flowMemories.orgId, orgId)))
    .orderBy(asc(flowMemories.createdAt));
}

export async function addFlowMemories(
  flowId: string,
  orgId: string,
  contents: string[],
  executionId: string,
): Promise<number> {
  // Count existing memories
  const [row] = await db
    .select({ count: count() })
    .from(flowMemories)
    .where(and(eq(flowMemories.flowId, flowId), eq(flowMemories.orgId, orgId)));
  const existing = row?.count ?? 0;
  const available = Math.max(0, MAX_MEMORIES_PER_FLOW - existing);
  if (available === 0) return 0;

  const toInsert = contents
    .slice(0, available)
    .map((c) => c.slice(0, MAX_MEMORY_CONTENT))
    .map((content) => ({ flowId, orgId, content, executionId }));

  if (toInsert.length === 0) return 0;

  const inserted = await db
    .insert(flowMemories)
    .values(toInsert)
    .returning({ id: flowMemories.id });
  return inserted.length;
}

export async function deleteFlowMemory(
  id: number,
  flowId: string,
  orgId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(flowMemories)
    .where(
      and(eq(flowMemories.id, id), eq(flowMemories.flowId, flowId), eq(flowMemories.orgId, orgId)),
    )
    .returning({ id: flowMemories.id });
  return deleted.length > 0;
}

export async function deleteAllFlowMemories(flowId: string, orgId: string): Promise<number> {
  const deleted = await db
    .delete(flowMemories)
    .where(and(eq(flowMemories.flowId, flowId), eq(flowMemories.orgId, orgId)))
    .returning({ id: flowMemories.id });
  return deleted.length;
}
