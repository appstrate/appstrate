import { eq, and, ne, desc, isNotNull, inArray, count } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { executions, executionLogs, packageVersions } from "@appstrate/db/schema";
import { logger } from "../../lib/logger.ts";
import { type Actor, actorInsert, actorFilter } from "../../lib/actor.ts";

// --- Executions ---

export async function createExecution(
  id: string,
  packageId: string,
  actor: Actor,
  orgId: string,
  input: Record<string, unknown> | null,
  scheduleId?: string,
  packageVersionId?: number,
  connectionProfileId?: string,
  proxyLabel?: string,
  modelLabel?: string,
  applicationId?: string | null,
  shareLinkId?: string,
): Promise<void> {
  await db.insert(executions).values({
    id,
    packageId,
    ...actorInsert(actor),
    orgId,
    status: "pending",
    input,
    startedAt: new Date(),
    connectionProfileId: connectionProfileId ?? null,
    scheduleId: scheduleId ?? null,
    packageVersionId: packageVersionId ?? null,
    proxyLabel: proxyLabel ?? null,
    modelLabel: modelLabel ?? null,
    applicationId: applicationId ?? null,
    shareLinkId: shareLinkId ?? null,
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
    cost?: number | null;
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
  if (updates.cost !== undefined) set.cost = updates.cost;

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
  actor: Actor,
  orgId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ state: executions.state })
    .from(executions)
    .where(
      and(
        eq(executions.packageId, packageId),
        actorFilter(actor, { userId: executions.userId, endUserId: executions.endUserId }),
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
  actor: Actor,
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
    actorFilter(actor, { userId: executions.userId, endUserId: executions.endUserId }),
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

export async function getLastExecution(packageId: string, actor: Actor, orgId: string) {
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
        actorFilter(actor, { userId: executions.userId, endUserId: executions.endUserId }),
        eq(executions.orgId, orgId),
      ),
    )
    .orderBy(desc(executions.startedAt))
    .limit(1);
  return row ?? null;
}

export async function appendExecutionLog(
  executionId: string,
  orgId: string,
  type: string,
  event: string | null,
  message: string | null,
  data: Record<string, unknown> | null,
  level: "debug" | "info" | "warn" | "error" = "debug",
): Promise<number> {
  try {
    const [row] = await db
      .insert(executionLogs)
      .values({
        executionId,
        orgId,
        type,
        event,
        message,
        data,
        level,
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
  actor?: Actor,
): Promise<number> {
  const conditions = [
    eq(executions.packageId, packageId),
    inArray(executions.status, ["running", "pending"]),
  ];

  if (actor) {
    conditions.push(
      actorFilter(actor, { userId: executions.userId, endUserId: executions.endUserId }),
    );
  }

  const [row] = await db
    .select({ count: count() })
    .from(executions)
    .where(and(...conditions));
  return row?.count ?? 0;
}

export async function getRunningExecutionCountForOrg(orgId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(executions)
    .where(and(eq(executions.orgId, orgId), inArray(executions.status, ["running", "pending"])));
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
    if (row.packageId) counts[row.packageId] = row.count;
  }
  return counts;
}

export async function getExecution(id: string) {
  const [row] = await db
    .select({
      id: executions.id,
      status: executions.status,
      userId: executions.userId,
      endUserId: executions.endUserId,
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

export async function listPackageExecutions(
  packageId: string,
  orgId: string,
  limit = 50,
  applicationId?: string | null,
) {
  const conditions = [eq(executions.packageId, packageId), eq(executions.orgId, orgId)];
  if (applicationId) {
    conditions.push(eq(executions.applicationId, applicationId));
  }

  const rows = await db
    .select({
      execution: executions,
      packageVersion: packageVersions.version,
    })
    .from(executions)
    .leftJoin(packageVersions, eq(executions.packageVersionId, packageVersions.id))
    .where(and(...conditions))
    .orderBy(desc(executions.startedAt))
    .limit(limit);
  return rows.map((r) => ({ ...r.execution, packageVersion: r.packageVersion }));
}

export async function getExecutionFull(id: string) {
  const [row] = await db
    .select({
      execution: executions,
      packageVersion: packageVersions.version,
    })
    .from(executions)
    .leftJoin(packageVersions, eq(executions.packageVersionId, packageVersions.id))
    .where(eq(executions.id, id))
    .limit(1);
  if (!row) return null;
  return { ...row.execution, packageVersion: row.packageVersion };
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
