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
import type { AppScope, OrgScope } from "../../lib/scope.ts";

export const RUN_HISTORY_FIELDS = ["checkpoint", "result"] as const;
export type RunHistoryField = (typeof RUN_HISTORY_FIELDS)[number];

import { asRecordOrNull } from "../../lib/safe-json.ts";
import { toISO } from "../../lib/date-helpers.ts";

/**
 * Shared SELECT shape for enriched-run reads. The three callers
 * (`listRunsWithFilter`, `listGlobalRuns`, `getRunFull`) each pair this
 * with the same five LEFT JOINs on `profiles`/`endUsers`/`apiKeys`/
 * `schedules`/`packages` — extracted here to keep the JOIN list inline
 * (Drizzle's query-builder types don't compose well through a helper).
 */
function enrichedRunSelect() {
  return {
    run: runs,
    dashboardUserName: profiles.displayName,
    endUserName: sql<string | null>`coalesce(${endUsers.name}, ${endUsers.externalId})`,
    apiKeyName: apiKeys.name,
    scheduleName: schedules.name,
    packageEphemeral: packages.ephemeral,
  };
}

/**
 * Null-coalescing mapper paired with `enrichedRunSelect()`. Single source
 * of truth for the "enriched run" wire shape — the three read helpers
 * call this instead of inlining the same mapping six lines six times.
 */
type EnrichedRunRow = {
  run: typeof runs.$inferSelect;
  dashboardUserName: string | null;
  endUserName: string | null;
  apiKeyName: string | null;
  scheduleName: string | null;
  packageEphemeral: boolean | null;
};

function mapEnrichedRun(r: EnrichedRunRow) {
  return {
    ...r.run,
    dashboardUserName: r.dashboardUserName ?? null,
    endUserName: r.endUserName ?? null,
    apiKeyName: r.apiKeyName ?? null,
    scheduleName: r.scheduleName ?? null,
    packageEphemeral: r.packageEphemeral ?? false,
  };
}

// --- Runs ---

async function nextRunNumber(scope: AppScope, packageId: string): Promise<number> {
  const [maxRow] = await db
    .select({ maxNum: max(runs.runNumber) })
    .from(runs)
    .where(
      scopedWhere(runs, {
        orgId: scope.orgId,
        applicationId: scope.applicationId,
        extra: [eq(runs.packageId, packageId)],
      }),
    );
  return (maxRow?.maxNum ?? 0) + 1;
}

interface CreateRunParams {
  id: string;
  packageId: string;
  actor: Actor | null;
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
  /** Snapshot of the effective agent config (merged overrides) at run creation. */
  config?: Record<string, unknown> | null;
  /**
   * Which runner drives this run. Platform-origin runs execute in a
   * server-managed Docker container; remote-origin runs execute on the
   * caller's host. Both speak the same HMAC-signed event protocol.
   */
  runOrigin?: "platform" | "remote";
  /** AES-256-GCM ciphertext of the per-run sink secret (via `@appstrate/connect`). */
  sinkSecretEncrypted?: string;
  /** Hard expiry beyond which `/events` rejects. Required when a sink is open. */
  sinkExpiresAt?: Date;
  /** Runner-provided execution environment metadata (os, cli version, git sha, ...). */
  contextSnapshot?: Record<string, unknown>;
  /**
   * Human-friendly runner label (e.g. CLI host, GitHub Action workflow id).
   * Resolved by `lib/runner-context.ts` from the request headers + auth
   * context and stamped on the run row at INSERT — denormalized so the
   * label survives session revocation and device rename.
   */
  runnerName?: string | null;
  /**
   * Free-form runner classifier driving the dashboard icon (`cli`,
   * `github-action`, …). Resolved alongside `runnerName`.
   */
  runnerKind?: string | null;
}

export async function createRun(scope: AppScope, params: CreateRunParams): Promise<void> {
  const { id, packageId, actor, input } = params;
  const runNumber = await nextRunNumber(scope, packageId);

  await db.insert(runs).values({
    id,
    packageId,
    dashboardUserId: actor?.type === "member" ? actor.id : null,
    endUserId: actor?.type === "end_user" ? actor.id : null,
    orgId: scope.orgId,
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
    applicationId: scope.applicationId,
    providerProfileIds: params.providerProfileIds,
    providerStatuses: params.providerStatuses,
    apiKeyId: params.apiKeyId,
    runNumber,
    agentScope: params.agentScope ?? null,
    agentName: params.agentName ?? null,
    config: params.config ?? null,
    runOrigin: params.runOrigin ?? "platform",
    ...(params.sinkSecretEncrypted !== undefined
      ? { sinkSecretEncrypted: params.sinkSecretEncrypted }
      : {}),
    ...(params.sinkExpiresAt !== undefined ? { sinkExpiresAt: params.sinkExpiresAt } : {}),
    ...(params.contextSnapshot !== undefined ? { contextSnapshot: params.contextSnapshot } : {}),
    runnerName: params.runnerName ?? null,
    runnerKind: params.runnerKind ?? null,
  });
}

/**
 * Create a run record that is immediately failed (preflight error).
 * Single INSERT with status=failed — triggers one pg_notify for realtime.
 */
export async function createFailedRun(
  scope: AppScope,
  id: string,
  packageId: string,
  actor: Actor | null,
  error: string,
  scheduleId?: string,
  connectionProfileId?: string,
  agentDenorm?: { scope?: string | null; name?: string | null },
): Promise<void> {
  const runNumber = await nextRunNumber(scope, packageId);
  const now = new Date();

  await db.insert(runs).values({
    id,
    packageId,
    dashboardUserId: actor?.type === "member" ? actor.id : null,
    endUserId: actor?.type === "end_user" ? actor.id : null,
    orgId: scope.orgId,
    applicationId: scope.applicationId,
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
  scope: AppScope,
  id: string,
  updates: {
    status?: string;
    result?: Record<string, unknown>;
    checkpoint?: Record<string, unknown>;
    error?: string;
    completedAt?: string;
    duration?: number;
    tokenUsage?: Record<string, unknown>;
    notifiedAt?: string;
    metadata?: Record<string, unknown>;
    /** ISO-8601 timestamp; closes the signed-event sink — subsequent POSTs reject with 410. */
    sinkClosedAt?: string;
  },
): Promise<void> {
  const set: Record<string, unknown> = {};

  if (updates.status !== undefined) set.status = updates.status;
  if (updates.error !== undefined) set.error = updates.error;
  if (updates.completedAt !== undefined) set.completedAt = new Date(updates.completedAt);
  if (updates.duration !== undefined) set.duration = updates.duration;
  if (updates.result !== undefined) set.result = updates.result;
  if (updates.checkpoint !== undefined) set.checkpoint = updates.checkpoint;
  if (updates.tokenUsage !== undefined) set.tokenUsage = updates.tokenUsage;
  if (updates.notifiedAt !== undefined) set.notifiedAt = new Date(updates.notifiedAt);
  if (updates.metadata !== undefined) set.metadata = updates.metadata;
  if (updates.sinkClosedAt !== undefined) set.sinkClosedAt = new Date(updates.sinkClosedAt);

  try {
    await db
      .update(runs)
      .set(set)
      .where(
        scopedWhere(runs, {
          orgId: scope.orgId,
          applicationId: scope.applicationId,
          extra: [eq(runs.id, id)],
        }),
      );
  } catch (err) {
    logger.error("Failed to update run", {
      runId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function getLastCheckpoint(
  scope: AppScope,
  packageId: string,
  actor: Actor | null,
): Promise<Record<string, unknown> | null> {
  const conditions = [
    eq(runs.packageId, packageId),
    eq(runs.orgId, scope.orgId),
    eq(runs.applicationId, scope.applicationId),
    isNotNull(runs.checkpoint),
  ];
  if (actor) {
    conditions.push(
      actorFilter(actor, { userId: runs.dashboardUserId, endUserId: runs.endUserId }),
    );
  }

  const [row] = await db
    .select({ checkpoint: runs.checkpoint })
    .from(runs)
    .where(and(...conditions))
    .orderBy(desc(runs.startedAt))
    .limit(1);
  return asRecordOrNull(row?.checkpoint);
}

export type RecentRunsField = RunHistoryField;

export async function getRecentRuns(
  scope: AppScope,
  packageId: string,
  actor: Actor | null,
  options: {
    limit?: number;
    fields?: RecentRunsField[];
    excludeRunId?: string;
  } = {},
): Promise<Record<string, unknown>[]> {
  const limit = options.limit ?? 10;
  const fields = options.fields ?? ["checkpoint"];

  const conditions = [
    eq(runs.packageId, packageId),
    eq(runs.orgId, scope.orgId),
    eq(runs.applicationId, scope.applicationId),
    eq(runs.status, "success"),
  ];
  // Actor isolation is mandatory — never leak cross-actor checkpoints.
  // Scheduled / system runs (`actor === null`) read the shared bucket only.
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
      checkpoint: runs.checkpoint,
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
    if (fields.includes("checkpoint")) entry.checkpoint = row.checkpoint;
    if (fields.includes("result")) entry.result = row.result;
    return entry;
  });
}

export async function getLastRun(scope: AppScope, packageId: string, actor: Actor | null) {
  const conditions = [
    eq(runs.packageId, packageId),
    eq(runs.orgId, scope.orgId),
    eq(runs.applicationId, scope.applicationId),
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

/**
 * Append a log entry for a run. Only org-scoped — `run_logs` is keyed on
 * `runId` (unique globally) + `orgId` only; no application column exists.
 * Callers that hold an `AppScope` can still pass it — `OrgScope` is the
 * structural supertype so `AppScope` flows through naturally.
 */
export async function appendRunLog(
  scope: OrgScope,
  runId: string,
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
        orgId: scope.orgId,
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
  scope: AppScope,
  packageId: string,
  actor?: Actor,
): Promise<number> {
  const conditions = [
    eq(runs.packageId, packageId),
    eq(runs.orgId, scope.orgId),
    inArray(runs.status, ["running", "pending"]),
  ];

  conditions.push(eq(runs.applicationId, scope.applicationId));

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

/**
 * Count in-flight runs across ALL applications in an org. Used by the
 * per-org concurrency limiter — genuinely org-scoped, no applicationId
 * filter. Signature stays org-scoped so the caller can't accidentally
 * scope it narrower.
 */
export async function getRunningRunCountForOrg(scope: OrgScope): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(runs)
    .where(
      scopedWhere(runs, {
        orgId: scope.orgId,
        extra: [inArray(runs.status, ["running", "pending"])],
      }),
    );
  return row?.count ?? 0;
}

export async function getRunningRunCounts(scope: AppScope): Promise<Record<string, number>> {
  const rows = await db
    .select({ packageId: runs.packageId, count: count() })
    .from(runs)
    .where(
      scopedWhere(runs, {
        orgId: scope.orgId,
        applicationId: scope.applicationId,
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

export async function getRun(scope: AppScope, id: string) {
  const conditions = [
    eq(runs.id, id),
    eq(runs.orgId, scope.orgId),
    eq(runs.applicationId, scope.applicationId),
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

export async function deletePackageRuns(scope: AppScope, packageId: string): Promise<number> {
  const deleted = await db
    .delete(runs)
    .where(
      scopedWhere(runs, {
        orgId: scope.orgId,
        applicationId: scope.applicationId,
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
    .select(enrichedRunSelect())
    .from(runs)
    .leftJoin(profiles, eq(runs.dashboardUserId, profiles.id))
    .leftJoin(endUsers, eq(runs.endUserId, endUsers.id))
    .leftJoin(apiKeys, eq(runs.apiKeyId, apiKeys.id))
    .leftJoin(schedules, eq(runs.scheduleId, schedules.id))
    .leftJoin(packages, eq(packages.id, runs.packageId))
    .where(filter)
    .orderBy(desc(runs.startedAt))
    .limit(limit)
    .offset(offset);

  return {
    runs: rows.map(mapEnrichedRun) as unknown as Record<string, unknown>[],
    total: countRow?.count ?? 0,
  };
}

export async function listPackageRuns(
  scope: AppScope,
  packageId: string,
  options: {
    limit?: number;
    offset?: number;
    endUserId?: string | null;
  } = {},
) {
  const { limit = 50, offset = 0, endUserId } = options;
  const conditions = [
    eq(runs.packageId, packageId),
    eq(runs.orgId, scope.orgId),
    eq(runs.applicationId, scope.applicationId),
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
  limit?: number;
  offset?: number;
  kind?: GlobalRunKind;
  status?: string;
  startDate?: Date;
  endDate?: Date;
  endUserId?: string | null;
}

export async function listGlobalRuns(
  scope: AppScope,
  options: ListGlobalRunsOptions = {},
): Promise<{
  runs: Record<string, unknown>[];
  total: number;
}> {
  const { limit = 50, offset = 0, kind, status, startDate, endDate, endUserId } = options;

  const conditions = [eq(runs.orgId, scope.orgId), eq(runs.applicationId, scope.applicationId)];
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
    .select(enrichedRunSelect())
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
    runs: rows.map(mapEnrichedRun) as unknown as Record<string, unknown>[],
    total: countRow?.count ?? 0,
  };
}

export async function listScheduleRuns(
  scope: AppScope,
  scheduleId: string,
  options: { limit?: number; offset?: number } = {},
) {
  const { limit = 20, offset = 0 } = options;
  return listRunsWithFilter(
    scopedWhere(runs, {
      orgId: scope.orgId,
      applicationId: scope.applicationId,
      extra: [eq(runs.scheduleId, scheduleId)],
    })!,
    limit,
    offset,
  );
}

export async function getRunFull(scope: AppScope, id: string) {
  const conditions = [
    eq(runs.id, id),
    eq(runs.orgId, scope.orgId),
    eq(runs.applicationId, scope.applicationId),
  ];

  const [row] = await db
    .select({
      ...enrichedRunSelect(),
      packageManifest: packages.draftManifest,
      packagePrompt: packages.draftContent,
    })
    .from(runs)
    .leftJoin(profiles, eq(runs.dashboardUserId, profiles.id))
    .leftJoin(endUsers, eq(runs.endUserId, endUsers.id))
    .leftJoin(apiKeys, eq(runs.apiKeyId, apiKeys.id))
    .leftJoin(schedules, eq(runs.scheduleId, schedules.id))
    .leftJoin(packages, eq(packages.id, runs.packageId))
    .where(and(...conditions))
    .limit(1);

  if (!row) return null;

  // For inline runs, expose manifest + prompt directly (shadow package is
  // filtered from catalog endpoints so the UI can't fetch them separately).
  // After compaction, draftManifest is `{}` and draftContent is `""` — we
  // normalize both to null so the frontend can show "Details expired".
  const isInline = row.packageEphemeral === true;
  const manifest = row.packageManifest as Record<string, unknown> | null;
  const inlineManifest = isInline && manifest && Object.keys(manifest).length > 0 ? manifest : null;
  const inlinePrompt = isInline && row.packagePrompt ? row.packagePrompt : null;

  return {
    ...mapEnrichedRun(row),
    inlineManifest,
    inlinePrompt,
  };
}

/**
 * Org-scoped run snapshot read. Intentionally narrower than
 * `getRun(scope, id)`: cross-app consumers span applications within a
 * single org, so the read scopes on `orgId` alone. Returns the public
 * `Run` DTO shape — schema internals (scheduler ids, actor fields, etc.)
 * stay inside apps/api.
 *
 * The `{ runId, orgId }` object-args shape is the module-facing public
 * contract (registered on `PlatformServices.runs.get`) — keep it stable.
 * App-scoped internal callers prefer `getRun(scope, runId)`.
 */
export async function getRunByOrg(args: { runId: string; orgId: string }) {
  const [row] = await db
    .select({
      id: runs.id,
      status: runs.status,
      orgId: runs.orgId,
      applicationId: runs.applicationId,
      packageId: runs.packageId,
      result: runs.result,
      error: runs.error,
    })
    .from(runs)
    .where(and(eq(runs.id, args.runId), eq(runs.orgId, args.orgId)))
    .limit(1);
  return row ?? null;
}

/**
 * Org-scoped run log read. `order: "asc"` (default) returns entries in
 * insertion order (`id ASC`); `"desc"` selects the most recent `limit`
 * entries and is cheaper when only a tail is needed. The returned batch
 * is always chronological — `desc` affects which rows are selected, not
 * the order callers receive.
 *
 * Org-scoped by design — `run_logs` has no `applicationId` column, and
 * the object-args shape is the module-facing public contract. App-scoped
 * callers must verify run ownership via `getRun(scope, runId)` first.
 */
export async function listRunLogs(args: {
  runId: string;
  orgId: string;
  limit?: number;
  order?: "asc" | "desc";
}) {
  const { runId, orgId, limit, order = "asc" } = args;
  const q = db
    .select()
    .from(runLogs)
    .where(and(eq(runLogs.runId, runId), eq(runLogs.orgId, orgId)))
    .orderBy(order === "desc" ? desc(runLogs.id) : runLogs.id);
  const rows = limit ? await q.limit(limit) : await q;
  return order === "desc" ? rows.reverse() : rows;
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
