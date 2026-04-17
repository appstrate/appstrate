// SPDX-License-Identifier: Apache-2.0

import {
  eq,
  and,
  ne,
  desc,
  isNotNull,
  inArray,
  count,
  gte,
  lte,
  max,
  type SQL,
  sql,
} from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  runs,
  runLogs,
  packages,
  profiles,
  endUsers,
  apiKeys,
  schedules,
} from "@appstrate/db/schema";
import type { RunProviderSnapshot } from "@appstrate/shared-types";
import { logger } from "../../lib/logger.ts";
import { scopedWhere } from "../../lib/db-helpers.ts";
import { type Actor, actorFilter } from "../../lib/actor.ts";

/** Maps an Actor to the runs table's `dashboardUserId`/`endUserId` columns. */
function runActorInsert(actor: Actor | null): {
  dashboardUserId: string | null;
  endUserId: string | null;
} {
  if (!actor) return { dashboardUserId: null, endUserId: null };
  return {
    dashboardUserId: actor.type === "member" ? actor.id : null,
    endUserId: actor.type === "end_user" ? actor.id : null,
  };
}
import { asRecordOrNull } from "../../lib/safe-json.ts";
import { toISO } from "../../lib/date-helpers.ts";

// --- Runs ---

async function nextRunNumber(
  packageId: string,
  orgId: string,
  applicationId: string,
): Promise<number> {
  const [maxRow] = await db
    .select({ maxNum: max(runs.runNumber) })
    .from(runs)
    .where(
      scopedWhere(runs, {
        orgId,
        applicationId,
        extra: [eq(runs.packageId, packageId)],
      }),
    );
  return (maxRow?.maxNum ?? 0) + 1;
}

interface CreateRunParams {
  id: string;
  packageId: string;
  actor: Actor | null;
  orgId: string;
  applicationId: string;
  input: Record<string, unknown> | null;
  scheduleId?: string;
  connectionProfileId?: string;
  versionLabel?: string;
  versionDirty?: boolean;
  proxyLabel?: string;
  modelLabel?: string;
  modelSource?: string;
  providerProfileIds?: Record<string, string>;
  providerStatuses?: RunProviderSnapshot[];
  apiKeyId?: string;
  /** Snapshot of the agent's @scope (e.g. "@acme") at run creation. */
  agentScope?: string | null;
  /** Snapshot of the agent's display name (manifest.displayName ?? name). */
  agentName?: string | null;
}

export async function createRun(params: CreateRunParams): Promise<void> {
  const { id, packageId, actor, orgId, applicationId, input } = params;
  const runNumber = await nextRunNumber(packageId, orgId, applicationId);

  await db.insert(runs).values({
    id,
    packageId,
    ...runActorInsert(actor),
    orgId,
    status: "pending",
    input,
    startedAt: new Date(),
    connectionProfileId: params.connectionProfileId,
    scheduleId: params.scheduleId,
    versionLabel: params.versionLabel,
    versionDirty: params.versionDirty ?? false,
    proxyLabel: params.proxyLabel,
    modelLabel: params.modelLabel,
    modelSource: params.modelSource,
    applicationId,
    providerProfileIds: params.providerProfileIds,
    providerStatuses: params.providerStatuses,
    apiKeyId: params.apiKeyId,
    runNumber,
    agentScope: params.agentScope ?? null,
    agentName: params.agentName ?? null,
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
  agentDenorm?: { scope?: string | null; name?: string | null },
): Promise<void> {
  const runNumber = await nextRunNumber(packageId, orgId, applicationId);
  const now = new Date();

  await db.insert(runs).values({
    id,
    packageId,
    ...runActorInsert(actor),
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
    agentScope: agentDenorm?.scope ?? null,
    agentName: agentDenorm?.name ?? null,
  });
}

export async function updateRun(
  id: string,
  orgId: string,
  applicationId: string,
  updates: {
    status?: string;
    result?: Record<string, unknown>;
    state?: Record<string, unknown>;
    error?: string;
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
      .where(scopedWhere(runs, { orgId, applicationId, extra: [eq(runs.id, id)] }));
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
    conditions.push(
      actorFilter(actor, { userId: runs.dashboardUserId, endUserId: runs.endUserId }),
    );
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
    conditions.push(
      actorFilter(actor, { userId: runs.dashboardUserId, endUserId: runs.endUserId }),
    );
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
    conditions.push(
      actorFilter(actor, { userId: runs.dashboardUserId, endUserId: runs.endUserId }),
    );
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
    conditions.push(
      actorFilter(actor, { userId: runs.dashboardUserId, endUserId: runs.endUserId }),
    );
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
    .where(scopedWhere(runs, { orgId, extra: [inArray(runs.status, ["running", "pending"])] }));
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
      scopedWhere(runs, {
        orgId,
        applicationId,
        extra: [inArray(runs.status, ["running", "pending"])],
      }),
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
      dashboardUserId: runs.dashboardUserId,
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
      scopedWhere(runs, {
        orgId,
        applicationId,
        extra: [eq(runs.packageId, packageId)],
      }),
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
      dashboardUserName: profiles.displayName,
      endUserName: sql<string | null>`coalesce(${endUsers.name}, ${endUsers.externalId})`,
      apiKeyName: apiKeys.name,
      scheduleName: schedules.name,
    })
    .from(runs)
    .leftJoin(profiles, eq(runs.dashboardUserId, profiles.id))
    .leftJoin(endUsers, eq(runs.endUserId, endUsers.id))
    .leftJoin(apiKeys, eq(runs.apiKeyId, apiKeys.id))
    .leftJoin(schedules, eq(runs.scheduleId, schedules.id))
    .where(filter)
    .orderBy(desc(runs.startedAt))
    .limit(limit)
    .offset(offset);

  return {
    runs: rows.map((r) => ({
      ...r.run,
      dashboardUserName: r.dashboardUserName ?? null,
      endUserName: r.endUserName ?? null,
      apiKeyName: r.apiKeyName ?? null,
      scheduleName: r.scheduleName ?? null,
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

/**
 * List runs across all packages in an org+application, paginated, with
 * optional kind / status / date / end-user filters. Powers the global
 * `GET /api/runs` view. Joins `packages.ephemeral` so the response carries
 * the inline flag — UI uses it for the "Inline" badge.
 */
export type GlobalRunKind = "all" | "package" | "inline";

type RunStatus = "pending" | "running" | "success" | "failed" | "timeout" | "cancelled";
const KNOWN_RUN_STATUSES: readonly RunStatus[] = [
  "pending",
  "running",
  "success",
  "failed",
  "timeout",
  "cancelled",
];
function isRunStatus(value: string): value is RunStatus {
  return (KNOWN_RUN_STATUSES as readonly string[]).includes(value);
}

export interface ListGlobalRunsOptions {
  applicationId: string;
  limit?: number;
  offset?: number;
  kind?: GlobalRunKind;
  status?: string;
  startDate?: Date;
  endDate?: Date;
  endUserId?: string | null;
}

export async function listGlobalRuns(
  orgId: string,
  options: ListGlobalRunsOptions,
): Promise<{
  runs: Record<string, unknown>[];
  total: number;
}> {
  const {
    applicationId,
    limit = 50,
    offset = 0,
    kind,
    status,
    startDate,
    endDate,
    endUserId,
  } = options;

  const conditions = [eq(runs.orgId, orgId), eq(runs.applicationId, applicationId)];
  if (status && isRunStatus(status)) conditions.push(eq(runs.status, status));
  if (startDate) conditions.push(gte(runs.startedAt, startDate));
  if (endDate) conditions.push(lte(runs.startedAt, endDate));
  if (endUserId) conditions.push(eq(runs.endUserId, endUserId));

  // Kind filter via JOINed `packages.ephemeral`.
  if (kind === "inline") conditions.push(eq(packages.ephemeral, true));
  else if (kind === "package") conditions.push(eq(packages.ephemeral, false));

  const filter = and(...conditions)!;

  const [countRow] = await db
    .select({ count: count() })
    .from(runs)
    .leftJoin(packages, eq(packages.id, runs.packageId))
    .where(filter);

  const rows = await db
    .select({
      run: runs,
      dashboardUserName: profiles.displayName,
      endUserName: sql<string | null>`coalesce(${endUsers.name}, ${endUsers.externalId})`,
      apiKeyName: apiKeys.name,
      scheduleName: schedules.name,
      packageEphemeral: packages.ephemeral,
    })
    .from(runs)
    .leftJoin(packages, eq(packages.id, runs.packageId))
    .leftJoin(profiles, eq(runs.dashboardUserId, profiles.id))
    .leftJoin(endUsers, eq(runs.endUserId, endUsers.id))
    .leftJoin(apiKeys, eq(runs.apiKeyId, apiKeys.id))
    .leftJoin(schedules, eq(runs.scheduleId, schedules.id))
    .where(filter)
    .orderBy(desc(runs.startedAt))
    .limit(limit)
    .offset(offset);

  return {
    runs: rows.map((r) => ({
      ...r.run,
      dashboardUserName: r.dashboardUserName ?? null,
      endUserName: r.endUserName ?? null,
      apiKeyName: r.apiKeyName ?? null,
      scheduleName: r.scheduleName ?? null,
      packageEphemeral: r.packageEphemeral ?? false,
    })) as unknown as Record<string, unknown>[],
    total: countRow?.count ?? 0,
  };
}

export async function listScheduleRuns(
  scheduleId: string,
  orgId: string,
  options: { limit?: number; offset?: number; applicationId: string },
) {
  const { limit = 20, offset = 0, applicationId } = options;
  return listRunsWithFilter(
    scopedWhere(runs, {
      orgId,
      applicationId,
      extra: [eq(runs.scheduleId, scheduleId)],
    })!,
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
      dashboardUserName: profiles.displayName,
      endUserName: sql<string | null>`coalesce(${endUsers.name}, ${endUsers.externalId})`,
      apiKeyName: apiKeys.name,
      scheduleName: schedules.name,
    })
    .from(runs)
    .leftJoin(profiles, eq(runs.dashboardUserId, profiles.id))
    .leftJoin(endUsers, eq(runs.endUserId, endUsers.id))
    .leftJoin(apiKeys, eq(runs.apiKeyId, apiKeys.id))
    .leftJoin(schedules, eq(runs.scheduleId, schedules.id))
    .where(and(...conditions))
    .limit(1);

  if (!row) return null;
  return {
    ...row.run,
    dashboardUserName: row.dashboardUserName ?? null,
    endUserName: row.endUserName ?? null,
    apiKeyName: row.apiKeyName ?? null,
    scheduleName: row.scheduleName ?? null,
  };
}

export async function listRunLogs(runId: string, orgId: string) {
  return db
    .select()
    .from(runLogs)
    .where(and(eq(runLogs.runId, runId), eq(runLogs.orgId, orgId)))
    .orderBy(runLogs.id);
}

/**
 * Mark all in-flight runs as failed on server restart.
 * ⚠️ Single-instance only — in multi-instance deployments, this will fail ALL
 * instances' in-flight runs. Multi-instance support requires per-instance run tracking.
 */
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
