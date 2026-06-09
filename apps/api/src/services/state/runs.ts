// SPDX-License-Identifier: Apache-2.0

import {
  eq,
  and,
  ne,
  gt,
  lt,
  or,
  desc,
  isNull,
  inArray,
  count,
  gte,
  lte,
  max,
  type SQL,
  sql,
} from "drizzle-orm";
import { db, type Db } from "@appstrate/db/client";
import {
  runs,
  runLogs,
  packages,
  profiles,
  endUsers,
  apiKeys,
  schedules,
  llmUsage,
  runStatusValues,
  activeRunStatusValues,
  type RunStatus,
} from "@appstrate/db/schema";
import { getEnv } from "@appstrate/env";
import { logger } from "../../lib/logger.ts";
import { listResponse } from "../../lib/list-response.ts";
import { scopedWhere } from "../../lib/db-helpers.ts";
import { type Actor, actorFilter } from "../../lib/actor.ts";
import {
  runMetadataSchema,
  runConfigSchema,
  runConfigOverrideSchema,
  runLogDataSchema,
} from "../../lib/jsonb-schemas.ts";
import { invalidRequest } from "../../lib/errors.ts";
import type { AppScope, OrgScope } from "../../lib/scope.ts";
import type {
  RunWireDto,
  EnrichedRun,
  RunConnectionUsed,
  ListEnvelope,
} from "@appstrate/shared-types";

export const RUN_HISTORY_FIELDS = ["checkpoint", "result"] as const;
export type RunHistoryField = (typeof RUN_HISTORY_FIELDS)[number];

function parseRunConfig(value: Record<string, unknown> | null | undefined) {
  if (value == null) return null;
  const result = runConfigSchema.safeParse(value);
  if (!result.success) {
    throw invalidRequest(
      `Invalid run config: ${result.error.issues[0]?.message ?? "validation failed"}`,
    );
  }
  return result.data;
}

function parseRunConfigOverride(value: Record<string, unknown> | null | undefined) {
  if (value == null) return null;
  const result = runConfigOverrideSchema.safeParse(value);
  if (!result.success) {
    throw invalidRequest(
      `Invalid run config override: ${result.error.issues[0]?.message ?? "validation failed"}`,
    );
  }
  return result.data;
}

function parseRunMetadata(value: Record<string, unknown>) {
  const result = runMetadataSchema.safeParse(value);
  if (!result.success) {
    throw invalidRequest(
      `Invalid run metadata: ${result.error.issues[0]?.message ?? "validation failed"}`,
    );
  }
  return result.data;
}

/**
 * Run-log writes are high-volume and best-effort — a malformed `data`
 * payload should not fail the surrounding event ingestion. Drop the
 * `data` field on validation failure and log the reason.
 */
function safeRunLogData(value: Record<string, unknown> | null) {
  if (value == null) return null;
  const result = runLogDataSchema.safeParse(value);
  if (!result.success) {
    logger.warn("Dropped invalid run_logs.data payload", {
      reason: result.error.issues[0]?.message,
    });
    return null;
  }
  return result.data;
}

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
    userName: profiles.displayName,
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
  userName: string | null;
  endUserName: string | null;
  apiKeyName: string | null;
  scheduleName: string | null;
  packageEphemeral: boolean | null;
};

/**
 * Translate a raw Drizzle `runs` row into its public snake_case wire DTO
 * (`@appstrate/shared-types` `RunWireDto`). This is the single bridge
 * between internal storage and external JSON, and it is responsible for
 * two things `c.json()` used to do implicitly/incorrectly:
 *
 *  1. Date → ISO string conversion happens HERE (`d?.toISOString() ?? null`)
 *     so the returned value's TS type matches the wire shape end-to-end
 *     instead of being erased at Hono's untyped `c.json()` boundary.
 *  2. DB-only columns are intentionally NOT projected. In particular
 *     `sinkSecretEncrypted` (an AES-256-GCM credential ciphertext),
 *     `sinkExpiresAt`, `sinkClosedAt`, `lastHeartbeatAt`, `lastEventSequence`
 *     (an internal ordering counter for the signed-event ingestion path —
 *     never part of the public run shape), and `resolvedConnections` are
 *     internal server state that must never reach a client. The previous
 *     spread-the-whole-row mapper leaked the credential ciphertext.
 *
 * The DB TS field names stay camelCase (Better Auth blocker); universal
 * DB-convention fields (id, *Id, *At) stay camelCase on the wire per Phase 3.
 */
// The explicit `: RunWireDto` return annotation is the drift guard: tsc fails
// if the mapper produces a field not on the wire DTO (the original bug leaked
// `sinkSecretEncrypted` via a spread) or the wrong type for one. A new runs
// column is only exposed if it is added here AND to `RunWireDto` deliberately.
/**
 * Derive the unambiguous `version_ref` of a run from the persisted
 * `(version_label, version_dirty)` pair (#636):
 *
 *   - `"draft"`   — the run executed the mutable draft AND its content
 *                   diverged from every published version (dirty heuristic),
 *                   or the agent had no published version at all (label is
 *                   NULL, or the literal `"draft"` label written by the
 *                   remote-runs registry resolver).
 *   - `"<semver>"`— the run executed that published definition (explicit
 *                   selector / new published-by-default path), or a draft
 *                   whose content had not changed since that version was
 *                   published (clean draft ≡ published snapshot).
 *
 * Derived, not stored: every historical run row already carries the pair, so
 * old runs get a correct ref without a migration.
 */
export function deriveVersionRef(versionLabel: string | null, versionDirty: boolean): string {
  if (versionDirty) return "draft";
  return versionLabel ?? "draft";
}

function runRowToWireDto(row: typeof runs.$inferSelect): RunWireDto {
  return {
    id: row.id,
    packageId: row.packageId,
    userId: row.userId,
    endUserId: row.endUserId,
    apiKeyId: row.apiKeyId,
    orgId: row.orgId,
    applicationId: row.applicationId,
    scheduleId: row.scheduleId,
    status: row.status,
    input: row.input,
    result: row.result,
    checkpoint: row.checkpoint,
    error: row.error,
    metadata: row.metadata,
    config: row.config,
    config_override: row.configOverride,
    started_at: row.startedAt?.toISOString() ?? null,
    completed_at: row.completedAt?.toISOString() ?? null,
    duration: row.duration,
    cost: row.cost,
    notifiedAt: row.notifiedAt?.toISOString() ?? null,
    readAt: row.readAt?.toISOString() ?? null,
    runNumber: row.runNumber,
    token_usage: row.tokenUsage,
    version_label: row.versionLabel,
    version_dirty: row.versionDirty,
    version_ref: deriveVersionRef(row.versionLabel, row.versionDirty),
    proxy_label: row.proxyLabel,
    model_label: row.modelLabel,
    model_source: row.modelSource,
    runner_name: row.runnerName,
    runner_kind: row.runnerKind,
    agent_scope: row.agentScope,
    agent_name: row.agentName,
    runOrigin: row.runOrigin,
    contextSnapshot: row.contextSnapshot,
    modelCredentialId: row.modelCredentialId,
    connection_overrides: row.connectionOverrides,
  };
}

/**
 * Project the internal `runs.resolved_connections` snapshot into the
 * display-safe `connections_used` wire shape. Drops the raw `connectionId`
 * (internal state) and keeps the denormalized label/account so the panel
 * renders even after the connection is renamed or deleted. Empty/absent → null.
 */
function projectConnectionsUsed(
  resolved: typeof runs.$inferSelect.resolvedConnections,
): RunConnectionUsed[] | null {
  if (!resolved || typeof resolved !== "object") return null;
  const entries = Object.entries(resolved);
  if (entries.length === 0) return null;
  return entries.map(([integrationId, v]) => ({
    integration_id: integrationId,
    label: v.label ?? null,
    account_id: v.accountId ?? null,
    source: v.source,
  }));
}

function mapEnrichedRun(r: EnrichedRunRow): EnrichedRun {
  return {
    ...runRowToWireDto(r.run),
    user_name: r.userName ?? null,
    end_user_name: r.endUserName ?? null,
    api_key_name: r.apiKeyName ?? null,
    schedule_name: r.scheduleName ?? null,
    connections_used: projectConnectionsUsed(r.run.resolvedConnections),
    package_ephemeral: r.packageEphemeral ?? false,
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
  versionLabel?: string;
  versionDirty?: boolean;
  proxyLabel?: string;
  modelLabel?: string;
  modelSource?: string;
  apiKeyId?: string;
  /** Snapshot of the agent's @scope (e.g. "@acme") at run creation. */
  agentScope?: string | null;
  /** Snapshot of the agent's display name (manifest.display_name ?? name). */
  agentName?: string | null;
  /** Snapshot of the effective agent config (merged overrides) at run creation. */
  config?: Record<string, unknown> | null;
  /**
   * Per-run override delta — the raw object the caller sent in the
   * request body (or `null` if the run used persisted defaults verbatim).
   * Persisted alongside the resolved `config` snapshot so the dashboard
   * can badge "default vs override" and the "Re-run with these settings"
   * button can replay the exact same delta.
   */
  configOverride?: Record<string, unknown> | null;
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
  /**
   * Caller's per-(integration, authKey) connection override map. Persisted
   * verbatim on `runs.connection_overrides` for audit + "re-run with same
   * picks" replay. Feeds the resolver's mechanism #2 at kickoff; surface
   * pinned admin choices and fallback if absent. Null when the run used
   * defaults verbatim.
   */
  connectionOverrides?: Record<string, string> | null;
  /**
   * Snapshot of the resolver output at kickoff: per integration, which
   * connection id was actually picked and which mechanism produced the
   * pick. Persisted on `runs.resolved_connections` so the credentials
   * resolver (sidecar MITM refresh) can honour the pick long after kickoff.
   */
  resolvedConnections?: Record<
    string,
    { connectionId: string; source: string; label?: string | null; accountId?: string | null }
  > | null;
  /**
   * `model_provider_credentials.id` snapshotted at run creation. Pinned
   * here so the OAuth model token resolver can reject any other
   * credentialId requested via the run's signed token. Set only for
   * platform-origin runs whose model resolves to an OAuth provider.
   */
  modelCredentialId?: string | null;
}

export async function createRun(scope: AppScope, params: CreateRunParams): Promise<void> {
  const { id, packageId, actor, input } = params;
  const runNumber = await nextRunNumber(scope, packageId);

  await db.insert(runs).values({
    id,
    packageId,
    userId: actor?.type === "user" ? actor.id : null,
    endUserId: actor?.type === "end_user" ? actor.id : null,
    orgId: scope.orgId,
    status: "pending",
    input,
    startedAt: new Date(),
    scheduleId: params.scheduleId,
    versionLabel: params.versionLabel,
    versionDirty: params.versionDirty ?? false,
    proxyLabel: params.proxyLabel,
    modelLabel: params.modelLabel,
    modelSource: params.modelSource,
    applicationId: scope.applicationId,
    apiKeyId: params.apiKeyId,
    runNumber,
    agentScope: params.agentScope ?? null,
    agentName: params.agentName ?? null,
    config: parseRunConfig(params.config),
    configOverride: parseRunConfigOverride(params.configOverride),
    runOrigin: params.runOrigin ?? "platform",
    ...(params.sinkSecretEncrypted !== undefined
      ? { sinkSecretEncrypted: params.sinkSecretEncrypted }
      : {}),
    ...(params.sinkExpiresAt !== undefined ? { sinkExpiresAt: params.sinkExpiresAt } : {}),
    ...(params.contextSnapshot !== undefined ? { contextSnapshot: params.contextSnapshot } : {}),
    runnerName: params.runnerName ?? null,
    runnerKind: params.runnerKind ?? null,
    modelCredentialId: params.modelCredentialId ?? null,
    ...(params.connectionOverrides !== undefined
      ? { connectionOverrides: params.connectionOverrides }
      : {}),
    ...(params.resolvedConnections !== undefined
      ? { resolvedConnections: params.resolvedConnections }
      : {}),
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
  agentDenorm?: { scope?: string | null; name?: string | null },
): Promise<void> {
  const runNumber = await nextRunNumber(scope, packageId);
  const now = new Date();

  await db.insert(runs).values({
    id,
    packageId,
    userId: actor?.type === "user" ? actor.id : null,
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
  executor: Db = db,
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
  if (updates.metadata !== undefined) set.metadata = parseRunMetadata(updates.metadata);
  if (updates.sinkClosedAt !== undefined) set.sinkClosedAt = new Date(updates.sinkClosedAt);

  await executor
    .update(runs)
    .set(set)
    .where(
      scopedWhere(runs, {
        orgId: scope.orgId,
        applicationId: scope.applicationId,
        extra: [eq(runs.id, id)],
      }),
    );
}

/**
 * Append an integration id to `runs.metadata.degraded_integrations[]` — the
 * record that a tool/api_call on that integration hit a terminal auth failure
 * (401/403 that survived the proxy's refresh+retry) during this run. Surfaced
 * in the run detail UI as a "reconnect" banner so a finished run shows the
 * degradation even when no one was watching the live `connection_update` badge.
 *
 * Atomic + idempotent via a single jsonb UPDATE: the `?` membership guard
 * makes a repeated report for the same integration a no-op, and concurrent
 * reports for DIFFERENT integrations on the same run cannot clobber each other
 * (`||` appends to whatever the row currently holds). Best-effort — never
 * throws into the caller; a metadata write must not break the refresh path.
 */
export async function recordRunDegradedIntegration(
  runId: string,
  integrationId: string,
): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE ${runs}
      SET metadata = jsonb_set(
        COALESCE(${runs.metadata}, '{}'::jsonb),
        '{degraded_integrations}',
        COALESCE(${runs.metadata} -> 'degraded_integrations', '[]'::jsonb)
          || to_jsonb(${integrationId}::text)
      )
      WHERE ${runs.id} = ${runId}
        AND NOT (COALESCE(${runs.metadata} -> 'degraded_integrations', '[]'::jsonb)
                 ? ${integrationId})
    `);
  } catch (err) {
    logger.warn("Failed to record degraded integration on run metadata", {
      runId,
      integrationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Compute the total attributable spend for a run from the unified
 * `llm_usage` ledger (proxy + runner rows). Called by `finalizeRun` to
 * cache the canonical `runs.cost` value at terminal time. This is the
 * SINGLE read path for aggregate run cost — no caller should SUM the
 * ledger directly. `credential_proxy_usage` is intentionally NOT summed:
 * it holds no cost. When the first metered integration ships, route its
 * rows through `llm_usage` with a new `source` enum value (e.g.
 * `credential_proxy`) — that keeps the single ledger invariant and
 * avoids adding a redundant SUM here.
 *
 * One scalar SUM over the `(run_id)` index — cheap even on long runs.
 */
export async function computeRunCost(runId: string): Promise<number> {
  const [llm] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${llmUsage.costUsd}), 0)`,
    })
    .from(llmUsage)
    .where(eq(llmUsage.runId, runId));

  return Number(llm?.total ?? 0);
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
  executor: Db = db,
): Promise<number> {
  const [row] = await executor
    .insert(runLogs)
    .values({
      runId,
      orgId: scope.orgId,
      type,
      event,
      message,
      data: safeRunLogData(data),
      level,
    })
    .returning({ id: runLogs.id });
  return row?.id ?? 0;
}

export async function getRunningRunsForPackage(
  scope: AppScope,
  packageId: string,
  actor?: Actor,
): Promise<number> {
  const conditions = [
    eq(runs.packageId, packageId),
    eq(runs.orgId, scope.orgId),
    inArray(runs.status, [...activeRunStatusValues]),
  ];

  conditions.push(eq(runs.applicationId, scope.applicationId));

  if (actor) {
    conditions.push(actorFilter(actor, { userId: runs.userId, endUserId: runs.endUserId }));
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
        extra: [inArray(runs.status, [...activeRunStatusValues])],
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
        extra: [inArray(runs.status, [...activeRunStatusValues])],
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

export type RunListPage = ListEnvelope<EnrichedRun> & { total: number };

export async function listRunsWithFilter(
  filter: SQL,
  limit: number,
  offset = 0,
): Promise<RunListPage> {
  const [countRow] = await db.select({ count: count() }).from(runs).where(filter);

  const rows = await db
    .select(enrichedRunSelect())
    .from(runs)
    .leftJoin(profiles, eq(runs.userId, profiles.id))
    .leftJoin(endUsers, eq(runs.endUserId, endUsers.id))
    .leftJoin(apiKeys, eq(runs.apiKeyId, apiKeys.id))
    .leftJoin(schedules, eq(runs.scheduleId, schedules.id))
    .leftJoin(packages, eq(packages.id, runs.packageId))
    .where(filter)
    .orderBy(desc(runs.startedAt))
    .limit(limit)
    .offset(offset);

  const data = rows.map(mapEnrichedRun);
  const total = countRow?.count ?? 0;
  return {
    ...listResponse(data, { hasMore: offset + data.length < total }),
    total,
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

function isRunStatus(value: string): value is RunStatus {
  return (runStatusValues as readonly string[]).includes(value);
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
): Promise<RunListPage> {
  const { limit = 50, offset = 0, kind, status, startDate, endDate, endUserId } = options;

  const conditions = [eq(runs.orgId, scope.orgId), eq(runs.applicationId, scope.applicationId)];
  if (status && isRunStatus(status)) conditions.push(eq(runs.status, status));
  if (startDate) conditions.push(gte(runs.startedAt, startDate));
  if (endDate) conditions.push(lte(runs.startedAt, endDate));
  if (endUserId) conditions.push(eq(runs.endUserId, endUserId));

  // Kind filter via JOINed `packages.ephemeral`. After migration 0017, runs
  // can outlive their source package (`runs.package_id ON DELETE SET NULL`),
  // in which case the LEFT JOIN produces a NULL `packages.ephemeral`. We
  // treat orphaned runs as `kind=package` (they were never inline shadows
  // — inline shadows live in `@inline/*` and persist after their run, so a
  // NULL `packages.ephemeral` here means the source row was a real catalog
  // package that has since been deleted).
  if (kind === "inline") {
    conditions.push(eq(packages.ephemeral, true));
  } else if (kind === "package") {
    conditions.push(or(eq(packages.ephemeral, false), isNull(packages.ephemeral))!);
  }

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
    .leftJoin(profiles, eq(runs.userId, profiles.id))
    .leftJoin(endUsers, eq(runs.endUserId, endUsers.id))
    .leftJoin(apiKeys, eq(runs.apiKeyId, apiKeys.id))
    .leftJoin(schedules, eq(runs.scheduleId, schedules.id))
    .where(filter)
    .orderBy(desc(runs.startedAt))
    .limit(limit)
    .offset(offset);

  const data = rows.map(mapEnrichedRun);
  const total = countRow?.count ?? 0;
  return {
    ...listResponse(data, { hasMore: offset + data.length < total }),
    total,
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
    .leftJoin(profiles, eq(runs.userId, profiles.id))
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
    inline_manifest: inlineManifest,
    inline_prompt: inlinePrompt,
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
 * `sinceId` (asc-only) returns rows with `id > sinceId`, the cursor used
 * by the CLI's polling loop in `runRemote`. Append-only `id` (BIGSERIAL)
 * makes this a stable monotonic cursor: callers track the last id they
 * rendered and pass it back, so each poll's payload size is bounded by
 * the rows produced since the previous poll instead of the run's full
 * history. Not legal with `order: "desc"` — the call throws to surface
 * the misuse rather than silently fall back to a full scan.
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
  sinceId?: number;
}) {
  const { runId, orgId, limit, order = "asc", sinceId } = args;
  if (sinceId !== undefined && order === "desc") {
    throw new Error("listRunLogs: sinceId is not supported with order=desc");
  }
  const filters = [eq(runLogs.runId, runId), eq(runLogs.orgId, orgId)];
  if (sinceId !== undefined) filters.push(gt(runLogs.id, sinceId));
  const q = db
    .select()
    .from(runLogs)
    .where(and(...filters))
    .orderBy(order === "desc" ? desc(runLogs.id) : runLogs.id);
  const rows = limit ? await q.limit(limit) : await q;
  return order === "desc" ? rows.reverse() : rows;
}

/**
 * List all in-flight run IDs at server startup. The caller (boot) feeds
 * each id through `synthesiseFinalize` so the same lifecycle that fires
 * for clean termination (afterRun, terminal log, onRunStatusChange) also
 * fires for runs that survived a server crash. Without that convergence,
 * any LLM tokens already burned by the crashed-runner before the crash
 * would silently never be billed (cloud's `afterRun` would never see them).
 *
 * Excludes runs a sibling instance is actively heartbeating: a run whose
 * `last_heartbeat_at` is within the watchdog stall threshold is being
 * driven by some live instance (this one or another), so finalizing it
 * here would terminate another instance's in-flight run. Only runs whose
 * heartbeat has already slipped past the stall threshold (the same cutoff
 * the watchdog uses to declare a runner stalled) are treated as orphans.
 *
 * ⚠️ Best-effort multi-instance guard only — heartbeat freshness cannot
 * distinguish "another instance owns this" from "this instance owns it but
 * crashed mid-run". Full multi-instance correctness requires a per-instance
 * `instance_id` column to attribute ownership; that is deferred.
 */
export async function listOrphanRunIds(): Promise<string[]> {
  const cutoff = new Date(Date.now() - getEnv().RUN_STALL_THRESHOLD_SECONDS * 1000);
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(inArray(runs.status, [...activeRunStatusValues]), lt(runs.lastHeartbeatAt, cutoff)));
  return rows.map((r) => r.id);
}

/**
 * Per-call `llm_usage` ledger rows for a run, org-scoped and filtered by source.
 *
 * Exposed to modules via `PlatformServices.runs.listLlmUsage` so a consumer that
 * aggregates per-call usage reads the canonical platform ledger through its API
 * instead of a cross-module SQL join into `llm_usage`. The caller reconciles on
 * the returned `id`s against its own store.
 */
export async function listLlmUsageForRun(args: {
  runId: string;
  orgId: string;
  sources: readonly string[];
}): Promise<Array<{ id: number; costUsd: number; source: string }>> {
  if (args.sources.length === 0) return [];
  return db
    .select({ id: llmUsage.id, costUsd: llmUsage.costUsd, source: llmUsage.source })
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.runId, args.runId),
        eq(llmUsage.orgId, args.orgId),
        inArray(llmUsage.source, args.sources as (typeof llmUsage.$inferSelect)["source"][]),
      ),
    );
}
