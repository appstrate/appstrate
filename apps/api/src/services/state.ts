import { eq, and, ne, desc, asc, isNotNull, isNull, inArray, count } from "drizzle-orm";
import { db } from "../lib/db.ts";
import {
  packageConfigs,
  executions,
  executionLogs,
  packageAdminConnections,
  packageMemories,
} from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";

// --- Package Config (per-org) ---

export async function getPackageConfig(
  orgId: string,
  packageId: string,
): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ config: packageConfigs.config })
    .from(packageConfigs)
    .where(and(eq(packageConfigs.orgId, orgId), eq(packageConfigs.packageId, packageId)))
    .limit(1);
  return (row?.config ?? {}) as Record<string, unknown>;
}

export async function setPackageConfig(
  orgId: string,
  packageId: string,
  config: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(packageConfigs)
    .values({
      orgId,
      packageId,
      config,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [packageConfigs.orgId, packageConfigs.packageId],
      set: {
        config,
        updatedAt: new Date(),
      },
    });
}

// --- Executions ---

export async function createExecution(
  id: string,
  packageId: string,
  userId: string,
  orgId: string,
  input: Record<string, unknown> | null,
  scheduleId?: string,
  packageVersionId?: number,
  connectionProfileId?: string,
): Promise<void> {
  await db.insert(executions).values({
    id,
    packageId,
    userId,
    orgId,
    status: "pending",
    input,
    startedAt: new Date(),
    connectionProfileId: connectionProfileId ?? null,
    scheduleId: scheduleId ?? null,
    packageVersionId: packageVersionId ?? null,
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
    notifiedAt?: string;
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
  if (updates.notifiedAt !== undefined) set.notifiedAt = new Date(updates.notifiedAt);

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
  packageId: string,
  userId: string,
  orgId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ state: executions.state })
    .from(executions)
    .where(
      and(
        eq(executions.packageId, packageId),
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
  packageId: string,
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
    eq(executions.packageId, packageId),
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

export async function getLastExecution(packageId: string, userId: string, orgId: string) {
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
        eq(executions.packageId, packageId),
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

export async function getRunningExecutionsForPackage(
  packageId: string,
  userId?: string,
): Promise<number> {
  const conditions = [
    eq(executions.packageId, packageId),
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
    .select({ packageId: executions.packageId, count: count() })
    .from(executions)
    .where(and(eq(executions.orgId, orgId), inArray(executions.status, ["running", "pending"])))
    .groupBy(executions.packageId);

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.packageId] = row.count;
  }
  return counts;
}

// --- Admin Connections (per-org) ---

export async function getAdminConnections(
  orgId: string,
  packageId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({
      serviceId: packageAdminConnections.serviceId,
      profileId: packageAdminConnections.profileId,
    })
    .from(packageAdminConnections)
    .where(
      and(
        eq(packageAdminConnections.orgId, orgId),
        eq(packageAdminConnections.packageId, packageId),
      ),
    );
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
  packageId: string,
  serviceId: string,
  profileId: string,
): Promise<void> {
  await db
    .insert(packageAdminConnections)
    .values({
      orgId,
      packageId,
      serviceId,
      profileId,
      connectedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [packageAdminConnections.packageId, packageAdminConnections.serviceId],
      set: {
        orgId,
        profileId,
        connectedAt: new Date(),
      },
    });
}

export async function unbindAdminConnection(
  orgId: string,
  packageId: string,
  serviceId: string,
): Promise<void> {
  await db
    .delete(packageAdminConnections)
    .where(
      and(
        eq(packageAdminConnections.orgId, orgId),
        eq(packageAdminConnections.packageId, packageId),
        eq(packageAdminConnections.serviceId, serviceId),
      ),
    );
}

export async function getExecution(id: string) {
  const [row] = await db
    .select({
      id: executions.id,
      status: executions.status,
      userId: executions.userId,
      orgId: executions.orgId,
      packageId: executions.packageId,
    })
    .from(executions)
    .where(eq(executions.id, id))
    .limit(1);
  return row ?? null;
}

export async function deletePackageExecutions(packageId: string, orgId: string): Promise<number> {
  const deleted = await db
    .delete(executions)
    .where(and(eq(executions.packageId, packageId), eq(executions.orgId, orgId)))
    .returning({ id: executions.id });
  return deleted.length;
}

export async function listPackageExecutions(packageId: string, orgId: string, limit = 50) {
  return db
    .select()
    .from(executions)
    .where(and(eq(executions.packageId, packageId), eq(executions.orgId, orgId)))
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

// --- Notifications ---

export async function markNotificationRead(
  executionId: string,
  userId: string,
  orgId: string,
): Promise<boolean> {
  const updated = await db
    .update(executions)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(executions.id, executionId),
        eq(executions.userId, userId),
        eq(executions.orgId, orgId),
        isNotNull(executions.notifiedAt),
      ),
    )
    .returning({ id: executions.id });
  return updated.length > 0;
}

export async function markAllNotificationsRead(userId: string, orgId: string): Promise<number> {
  const updated = await db
    .update(executions)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(executions.userId, userId),
        eq(executions.orgId, orgId),
        isNotNull(executions.notifiedAt),
        isNull(executions.readAt),
      ),
    )
    .returning({ id: executions.id });
  return updated.length;
}

export async function getUnreadNotificationCount(userId: string, orgId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(executions)
    .where(
      and(
        eq(executions.userId, userId),
        eq(executions.orgId, orgId),
        isNotNull(executions.notifiedAt),
        isNull(executions.readAt),
      ),
    );
  return row?.count ?? 0;
}

export async function listUserExecutions(
  userId: string,
  orgId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ executions: Record<string, unknown>[]; total: number }> {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;

  const [countRow] = await db
    .select({ count: count() })
    .from(executions)
    .where(and(eq(executions.userId, userId), eq(executions.orgId, orgId)));

  const rows = await db
    .select()
    .from(executions)
    .where(and(eq(executions.userId, userId), eq(executions.orgId, orgId)))
    .orderBy(desc(executions.startedAt))
    .limit(limit)
    .offset(offset);

  return { executions: rows as unknown as Record<string, unknown>[], total: countRow?.count ?? 0 };
}

// --- Package Memories (org-scoped, accumulate across executions) ---

const MAX_MEMORY_CONTENT = 2000;
const MAX_MEMORIES_PER_PACKAGE = 100;

export async function getPackageMemories(packageId: string, orgId: string) {
  return db
    .select()
    .from(packageMemories)
    .where(and(eq(packageMemories.packageId, packageId), eq(packageMemories.orgId, orgId)))
    .orderBy(asc(packageMemories.createdAt));
}

export async function addPackageMemories(
  packageId: string,
  orgId: string,
  contents: string[],
  executionId: string,
): Promise<number> {
  // Count existing memories
  const [row] = await db
    .select({ count: count() })
    .from(packageMemories)
    .where(and(eq(packageMemories.packageId, packageId), eq(packageMemories.orgId, orgId)));
  const existing = row?.count ?? 0;
  const available = Math.max(0, MAX_MEMORIES_PER_PACKAGE - existing);
  if (available === 0) return 0;

  const toInsert = contents
    .slice(0, available)
    .map((c) => c.slice(0, MAX_MEMORY_CONTENT))
    .map((content) => ({ packageId, orgId, content, executionId }));

  if (toInsert.length === 0) return 0;

  const inserted = await db
    .insert(packageMemories)
    .values(toInsert)
    .returning({ id: packageMemories.id });
  return inserted.length;
}

export async function deletePackageMemory(
  id: number,
  packageId: string,
  orgId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(packageMemories)
    .where(
      and(
        eq(packageMemories.id, id),
        eq(packageMemories.packageId, packageId),
        eq(packageMemories.orgId, orgId),
      ),
    )
    .returning({ id: packageMemories.id });
  return deleted.length > 0;
}

export async function deleteAllPackageMemories(packageId: string, orgId: string): Promise<number> {
  const deleted = await db
    .delete(packageMemories)
    .where(and(eq(packageMemories.packageId, packageId), eq(packageMemories.orgId, orgId)))
    .returning({ id: packageMemories.id });
  return deleted.length;
}
