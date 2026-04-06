// SPDX-License-Identifier: Apache-2.0

import { eq, and, ne, desc, isNotNull, inArray, count, max, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, runLogs, packageVersions } from "@appstrate/db/schema";
import { logger } from "../../lib/logger.ts";
import { type Actor, actorInsert, actorFilter } from "../../lib/actor.ts";
import { asRecordOrNull } from "../../lib/safe-json.ts";
import { toISO } from "../../lib/date-helpers.ts";

// --- Runs ---

async function nextRunNumber(packageId: string, orgId: string): Promise<number> {
  const [maxRow] = await db
    .select({ maxNum: max(runs.runNumber) })
    .from(runs)
    .where(and(eq(runs.packageId, packageId), eq(runs.orgId, orgId)));
  return (maxRow?.maxNum ?? 0) + 1;
}

export async function createRun(
  id: string,
  packageId: string,
  actor: Actor | null,
  orgId: string,
  applicationId: string,
  input: Record<string, unknown> | null,
  scheduleId?: string,
  packageVersionId?: number,
  connectionProfileId?: string,
  proxyLabel?: string,
  modelLabel?: string,
  modelSource?: string,
  providerProfileIds?: Record<string, string>,
): Promise<void> {
  const runNumber = await nextRunNumber(packageId, orgId);

  await db.insert(runs).values({
    id,
    packageId,
    ...(actor ? actorInsert(actor) : { userId: null, endUserId: null }),
    orgId,
    status: "pending",
    input,
    startedAt: new Date(),
    connectionProfileId,
    scheduleId,
    packageVersionId,
    proxyLabel,
    modelLabel,
    modelSource,
    applicationId,
    providerProfileIds,
    runNumber,
  });
}

/**
 * Create a run record that is immediately failed (preflight error).
 * Single INSERT with status=failed — triggers one pg_notify for realtime.
 */
export async function createFailedRun(
  id: string,
  packageId: string,
  actor: Actor | null,
  orgId: string,
  applicationId: string,
  error: string,
  scheduleId?: string,
  connectionProfileId?: string,
): Promise<void> {
  const runNumber = await nextRunNumber(packageId, orgId);
  const now = new Date();

  await db.insert(runs).values({
    id,
    packageId,
    ...(actor ? actorInsert(actor) : { userId: null, endUserId: null }),
    orgId,
    applicationId,
    status: "failed",
    input: null,
    error,
    startedAt: now,
    completedAt: now,
    duration: 0,
    notifiedAt: now,
    connectionProfileId,
    scheduleId,
    runNumber,
  });
}

export async function updateRun(
  id: string,
  orgId: string,
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
    metadata?: Record<string, unknown>;
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
  if (updates.metadata !== undefined) set.metadata = updates.metadata;

  try {
    await db
      .update(runs)
      .set(set)
      .where(and(eq(runs.id, id), eq(runs.orgId, orgId)));
  } catch (err) {
    logger.error("Failed to update run", {
      runId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function getLastRunState(
  packageId: string,
  actor: Actor | null,
  orgId: string,
  applicationId: string,
): Promise<Record<string, unknown> | null> {
  const conditions = [
    eq(runs.packageId, packageId),
    eq(runs.orgId, orgId),
    eq(runs.applicationId, applicationId),
    isNotNull(runs.state),
  ];
  if (actor) {
    conditions.push(actorFilter(actor, { userId: runs.userId, endUserId: runs.endUserId }));
  }

  const [row] = await db
    .select({ state: runs.state })
    .from(runs)
    .where(and(...conditions))
    .orderBy(desc(runs.startedAt))
    .limit(1);
  return asRecordOrNull(row?.state);
}

export async function getRecentRuns(
  packageId: string,
  actor: Actor | null,
  orgId: string,
  applicationId: string,
  options: {
    limit?: number;
    fields?: ("state" | "result")[];
    excludeRunId?: string;
  } = {},
): Promise<Record<string, unknown>[]> {
  const limit = options.limit ?? 10;
  const fields = options.fields ?? ["state"];

  const conditions = [
    eq(runs.packageId, packageId),
    eq(runs.orgId, orgId),
    eq(runs.applicationId, applicationId),
    eq(runs.status, "success"),
  ];
  if (actor) {
    conditions.push(actorFilter(actor, { userId: runs.userId, endUserId: runs.endUserId }));
  }

  if (options.excludeRunId) {
    conditions.push(ne(runs.id, options.excludeRunId));
  }

  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      startedAt: runs.startedAt,
      duration: runs.duration,
      state: runs.state,
      result: runs.result,
    })
    .from(runs)
    .where(and(...conditions))
    .orderBy(desc(runs.startedAt))
    .limit(limit);

  return rows.map((row) => {
    const entry: Record<string, unknown> = {
      id: row.id,
      status: row.status,
      date: toISO(row.startedAt),
      duration: row.duration,
    };
    if (fields.includes("state")) entry.state = row.state;
    if (fields.includes("result")) entry.result = row.result;
    return entry;
  });
}

export async function getLastRun(
  packageId: string,
  actor: Actor | null,
  orgId: string,
  applicationId: string,
) {
  const conditions = [
    eq(runs.packageId, packageId),
    eq(runs.orgId, orgId),
    eq(runs.applicationId, applicationId),
  ];
  if (actor) {
    conditions.push(actorFilter(actor, { userId: runs.userId, endUserId: runs.endUserId }));
  }

  const [row] = await db
    .select({
      id: runs.id,
      status: runs.status,
      startedAt: runs.startedAt,
      duration: runs.duration,
    })
    .from(runs)
    .where(and(...conditions))
    .orderBy(desc(runs.startedAt))
    .limit(1);
  return row ?? null;
}

export async function appendRunLog(
  runId: string,
  orgId: string,
  type: string,
  event: string | null,
  message: string | null,
  data: Record<string, unknown> | null,
  level: "debug" | "info" | "warn" | "error" = "debug",
): Promise<number> {
  try {
    const [row] = await db
      .insert(runLogs)
      .values({
        runId,
        orgId,
        type,
        event,
        message,
        data,
        level,
      })
      .returning({ id: runLogs.id });
    return row?.id ?? 0;
  } catch (err) {
    logger.error("Failed to append run log", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

export async function getRunningRunsForPackage(
  packageId: string,
  orgId: string,
  applicationId: string,
  actor?: Actor,
): Promise<number> {
  const conditions = [
    eq(runs.packageId, packageId),
    eq(runs.orgId, orgId),
    inArray(runs.status, ["running", "pending"]),
  ];

  conditions.push(eq(runs.applicationId, applicationId));

  if (actor) {
    conditions.push(actorFilter(actor, { userId: runs.userId, endUserId: runs.endUserId }));
  }

  const [row] = await db
    .select({ count: count() })
    .from(runs)
    .where(and(...conditions));
  return row?.count ?? 0;
}

export async function getRunningRunCountForOrg(orgId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(runs)
    .where(and(eq(runs.orgId, orgId), inArray(runs.status, ["running", "pending"])));
  return row?.count ?? 0;
}

export async function getRunningRunCounts(
  orgId: string,
  applicationId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ packageId: runs.packageId, count: count() })
    .from(runs)
    .where(
      and(
        eq(runs.orgId, orgId),
        eq(runs.applicationId, applicationId),
        inArray(runs.status, ["running", "pending"]),
      ),
    )
    .groupBy(runs.packageId);

  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.packageId) counts[row.packageId] = row.count;
  }
  return counts;
}

export async function getRun(id: string, orgId: string, applicationId: string) {
  const conditions = [
    eq(runs.id, id),
    eq(runs.orgId, orgId),
    eq(runs.applicationId, applicationId),
  ];

  const [row] = await db
    .select({
      id: runs.id,
      status: runs.status,
      userId: runs.userId,
      endUserId: runs.endUserId,
      orgId: runs.orgId,
      packageId: runs.packageId,
      applicationId: runs.applicationId,
    })
    .from(runs)
    .where(and(...conditions))
    .limit(1);
  return row ?? null;
}

export async function deletePackageRuns(
  packageId: string,
  orgId: string,
  applicationId: string,
): Promise<number> {
  const deleted = await db
    .delete(runs)
    .where(
      and(
        eq(runs.packageId, packageId),
        eq(runs.orgId, orgId),
        eq(runs.applicationId, applicationId),
      ),
    )
    .returning({ id: runs.id });
  return deleted.length;
}

export async function listRunsWithFilter(
  filter: SQL,
  limit: number,
  offset = 0,
): Promise<{ runs: Record<string, unknown>[]; total: number }> {
  const [countRow] = await db.select({ count: count() }).from(runs).where(filter);

  const rows = await db
    .select({
      run: runs,
      packageVersion: packageVersions.version,
    })
    .from(runs)
    .leftJoin(packageVersions, eq(runs.packageVersionId, packageVersions.id))
    .where(filter)
    .orderBy(desc(runs.startedAt))
    .limit(limit)
    .offset(offset);

  return {
    runs: rows.map((r) => ({
      ...r.run,
      packageVersion: r.packageVersion,
    })) as unknown as Record<string, unknown>[],
    total: countRow?.count ?? 0,
  };
}

export async function listPackageRuns(
  packageId: string,
  orgId: string,
  options: {
    limit?: number;
    offset?: number;
    applicationId: string;
    endUserId?: string | null;
  },
) {
  const { limit = 50, offset = 0, applicationId, endUserId } = options;
  const conditions = [
    eq(runs.packageId, packageId),
    eq(runs.orgId, orgId),
    eq(runs.applicationId, applicationId),
  ];
  if (endUserId) {
    conditions.push(eq(runs.endUserId, endUserId));
  }
  return listRunsWithFilter(and(...conditions)!, limit, offset);
}

export async function listScheduleRuns(
  scheduleId: string,
  orgId: string,
  options: { limit?: number; offset?: number; applicationId: string },
) {
  const { limit = 20, offset = 0, applicationId } = options;
  return listRunsWithFilter(
    and(
      eq(runs.scheduleId, scheduleId),
      eq(runs.orgId, orgId),
      eq(runs.applicationId, applicationId),
    )!,
    limit,
    offset,
  );
}

export async function getRunFull(id: string, orgId: string, applicationId: string) {
  const conditions = [
    eq(runs.id, id),
    eq(runs.orgId, orgId),
    eq(runs.applicationId, applicationId),
  ];

  const [row] = await db
    .select({
      run: runs,
      packageVersion: packageVersions.version,
    })
    .from(runs)
    .leftJoin(packageVersions, eq(runs.packageVersionId, packageVersions.id))
    .where(and(...conditions))
    .limit(1);
  if (!row) return null;
  return { ...row.run, packageVersion: row.packageVersion };
}

export async function listRunLogs(runId: string, orgId: string) {
  return db
    .select()
    .from(runLogs)
    .where(and(eq(runLogs.runId, runId), eq(runLogs.orgId, orgId)))
    .orderBy(runLogs.id);
}

export async function markOrphanRunsFailed(): Promise<{
  count: number;
  runIds: string[];
}> {
  const updated = await db
    .update(runs)
    .set({
      status: "failed",
      error: "Server restarted while run was in progress. Please retry.",
      completedAt: new Date(),
    })
    .where(inArray(runs.status, ["running", "pending"]))
    .returning({ id: runs.id });
  return { count: updated.length, runIds: updated.map((r) => r.id) };
}
