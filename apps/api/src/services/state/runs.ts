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
  notifications,
  documents,
  runStatusValues,
  activeRunStatusValues,
  type RunStatus,
} from "@appstrate/db/schema";
import { extractDocumentIds } from "@appstrate/core/document-uri";
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
import { ApiError, invalidRequest } from "../../lib/errors.ts";
import { getPlatformRunLimits } from "../run-limits.ts";
import { detachOrDeleteContainedDocuments } from "../documents.ts";
import { normalizeScope } from "@appstrate/core/naming";
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
function enrichedRunSelect(actor: Actor | null) {
  return {
    run: runs,
    userName: profiles.displayName,
    endUserName: sql<string | null>`coalesce(${endUsers.name}, ${endUsers.externalId})`,
    apiKeyName: apiKeys.name,
    scheduleName: schedules.name,
    packageEphemeral: packages.ephemeral,
    unread: unreadForActor(actor),
    // OUTPUT document count — correlated scalar subquery over `documents`,
    // served by the `idx_documents_run` (run_id-leading) index so the list
    // read stays a single query with no N+1. Coerced to Number in the mapper
    // (postgres.js returns count() as a numeric string).
    outputDocumentCount: sql<number>`(
      select count(*) from ${documents} where ${documents.runId} = ${runs.id}
    )`,
  };
}

/**
 * Per-recipient unread flag for the run's notification, computed as a
 * correlated EXISTS against the `notifications` table (issue #667). The
 * recipient is matched on the polymorphic `(recipientType, recipientId)`
 * tuple — the same match the notifications service uses — so a dashboard
 * user and an end-user never see each other's read-state. Read state lives
 * ONLY in `notifications`; runs carry no notification flag of their own. When
 * the read is not actor-scoped (e.g. a system/sidecar read with
 * `actor === null`), unread is constant `false` — the badge is a
 * dashboard-recipient concept.
 */
function unreadForActor(actor: Actor | null): SQL<boolean> {
  if (!actor) return sql<boolean>`false`;
  return sql<boolean>`exists (
    select 1 from ${notifications}
    where ${notifications.runId} = ${runs.id}
      and ${notifications.recipientType} = ${actor.type}
      and ${notifications.recipientId} = ${actor.id}
      and ${notifications.readAt} is null
  )`;
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
  unread: boolean;
  outputDocumentCount: number;
};

/**
 * Project a stored `runs.result` payload onto the documented output-only wire
 * shape. Historical rows may carry the removed #632 `text`/`text_truncated`
 * keys and no `output`; those — like a NULL result — map to `null`, matching
 * the OpenAPI contract (`result` is null when no structured output was
 * emitted) rather than serializing as an empty `{}`.
 */
function projectResultOutput(result: { output?: unknown } | null): { output: unknown } | null {
  const output = result?.output;
  return output === undefined ? null : { output };
}

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
    // Historical rows may carry `text`/`text_truncated` keys from the removed
    // #632 report channel; project to the documented output-only shape so the
    // dropped fields never leak onto the wire.
    result: projectResultOutput(row.result),
    checkpoint: row.checkpoint,
    error: row.error,
    metadata: row.metadata,
    config: row.config,
    config_override: row.configOverride,
    started_at: row.startedAt?.toISOString() ?? null,
    completed_at: row.completedAt?.toISOString() ?? null,
    duration: row.duration,
    cost: row.cost,
    runNumber: row.runNumber,
    token_usage: row.tokenUsage,
    version_label: row.versionLabel,
    version_ref: row.versionRef,
    proxy_label: row.proxyLabel,
    model_label: row.modelLabel,
    model_source: row.modelSource,
    runner_name: row.runnerName,
    runner_kind: row.runnerKind,
    // Stored bare on historical rows; emitted with the `@` sigil so every
    // API surface uses the one canonical scope format (issue #629).
    agent_scope: row.agentScope ? normalizeScope(row.agentScope) : null,
    agent_name: row.agentName,
    runOrigin: row.runOrigin,
    contextSnapshot: row.contextSnapshot,
    modelCredentialId: row.modelCredentialId,
    connection_overrides: row.connectionOverrides,
    dependency_overrides: row.dependencyOverrides,
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
    unread: r.unread,
    // INPUT = distinct `document://` ids referenced in the run's persisted
    // input JSON (extractDocumentIds dedupes + tolerates null); OUTPUT =
    // documents produced by the run (subquery column above).
    document_counts: {
      input: extractDocumentIds(r.run.input).length,
      output: Number(r.outputDocumentCount),
    },
  };
}

// --- Runs ---

/** An open Drizzle transaction handle (same query surface as `db`). */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function nextRunNumber(
  executor: Db | DbTx,
  scope: AppScope,
  packageId: string,
): Promise<number> {
  const [maxRow] = await executor
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

/**
 * Serialize `run_number` allocation per (org, application, package) with a
 * transaction-scoped Postgres advisory lock. Without it, two concurrent runs
 * of the same package both `SELECT max(run_number)+1`, read the same value and
 * insert colliding numbers (READ COMMITTED lets neither see the other's
 * uncommitted row). The lock forces the second max+insert to wait for the
 * first to commit, so it observes the freshly inserted row. Released
 * automatically at transaction end.
 */
async function acquireRunNumberLock(tx: DbTx, scope: AppScope, packageId: string): Promise<void> {
  const lockKey = `run_number:${scope.orgId ?? ""}:${scope.applicationId ?? ""}:${packageId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`);
}

/**
 * Advisory-lock key serializing per-org run admission. Single-sourced so
 * every party that must serialize against admission (`enforceOrgConcurrencyCap`
 * below, `deleteOrganization`) derives the exact same key.
 */
export function orgRunConcurrencyLockKey(orgId: string): string {
  return `run_concurrency:${orgId}`;
}

/**
 * Atomic per-org concurrency reservation. The shared preflight gate
 * (`run-preflight-gates.ts`) does a fast count-based pre-check that rejects
 * most over-cap launches BEFORE the ~1.75s pipeline work, but that check is
 * not atomic: two launches can both read `count < cap` in the window between
 * the gate and the run INSERT (~1.75s later) and overshoot the cap.
 *
 * This runs inside `createRun`'s transaction, immediately before the INSERT,
 * under a per-org transaction-scoped advisory lock — so the count and the
 * insert are atomic w.r.t. other concurrent admissions for the same org. The
 * lock serializes admission per org; the cap therefore holds exactly. Throws a
 * 429 `org_run_concurrency_exceeded` (same code the gate surfaces) when at cap.
 *
 * A no-op when the run-limits registry is not initialized (e.g. an isolated
 * unit test that never booted it) — there is no cap to enforce.
 */
async function enforceOrgConcurrencyCap(tx: DbTx, scope: AppScope): Promise<void> {
  let cap: number;
  try {
    cap = getPlatformRunLimits().max_concurrent_per_org;
  } catch {
    return;
  }
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${orgRunConcurrencyLockKey(scope.orgId ?? "")})::bigint)`,
  );
  const [row] = await tx
    .select({ active: count() })
    .from(runs)
    .where(
      scopedWhere(runs, {
        orgId: scope.orgId,
        extra: [inArray(runs.status, [...activeRunStatusValues])],
      }),
    );
  if ((row?.active ?? 0) >= cap) {
    throw new ApiError({
      status: 429,
      code: "org_run_concurrency_exceeded",
      title: "Org Run Concurrency Exceeded",
      detail: `Organization concurrent run limit reached (${cap}). Wait for in-flight runs to complete.`,
    });
  }
}

interface CreateRunParams {
  id: string;
  packageId: string;
  actor: Actor | null;
  input: Record<string, unknown> | null;
  scheduleId?: string;
  versionLabel?: string;
  versionRef?: string;
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
   * Per-run dependency version overrides (#666) — the `{ "@scope/name":
   * "draft" | "<spec>" }` map the caller passed on the run trigger (or a
   * schedule froze). Persisted verbatim on `runs.dependency_overrides` as the
   * audit trail so a run that consumed draft bytes is never mistaken for a
   * reproducible one. Null when the run resolved the manifest pins verbatim.
   */
  dependencyOverrides?: Record<string, string> | null;
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
   * Snapshot of each declared integration's resolved manifest version at
   * kickoff (#686). Persisted on `runs.resolved_integration_versions` so the
   * runtime credential path reads the SAME version the spawn resolver used.
   */
  resolvedIntegrationVersions?: Record<
    string,
    { version: string | null; source: "version" | "draft" | "system" }
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

  await db.transaction(async (tx) => {
    // Order matters: acquire the per-org concurrency lock before the per-package
    // run_number lock (consistent lock ordering across callers → no deadlock).
    await enforceOrgConcurrencyCap(tx, scope);
    await acquireRunNumberLock(tx, scope, packageId);
    const runNumber = await nextRunNumber(tx, scope, packageId);

    await tx.insert(runs).values({
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
      versionRef: params.versionRef ?? "draft",
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
      ...(params.dependencyOverrides !== undefined
        ? { dependencyOverrides: params.dependencyOverrides }
        : {}),
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
      ...(params.resolvedIntegrationVersions !== undefined
        ? { resolvedIntegrationVersions: params.resolvedIntegrationVersions }
        : {}),
    });
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
  const now = new Date();

  await db.transaction(async (tx) => {
    await acquireRunNumberLock(tx, scope, packageId);
    const runNumber = await nextRunNumber(tx, scope, packageId);

    await tx.insert(runs).values({
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
      scheduleId,
      runNumber,
      agentScope: agentDenorm?.scope ?? null,
      agentName: agentDenorm?.name ?? null,
    });
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
  if (updates.metadata !== undefined) set.metadata = parseRunMetadata(updates.metadata);
  if (updates.sinkClosedAt !== undefined) set.sinkClosedAt = new Date(updates.sinkClosedAt);

  // Monotone status invariant, enforced in the WHERE (not read-then-write):
  // a run that reached a terminal status (success|failed|timeout|cancelled)
  // can never be flipped back to an active one. Without this guard a late
  // "flip to running" (e.g. event ingestion racing finalize) would resurrect
  // a finished run. Terminal → terminal updates stay allowed; only updates
  // that SET an active status are constrained to rows still active.
  const extra: SQL[] = [eq(runs.id, id)];
  if (
    updates.status !== undefined &&
    (activeRunStatusValues as readonly string[]).includes(updates.status)
  ) {
    extra.push(inArray(runs.status, [...activeRunStatusValues]));
  }

  await executor
    .update(runs)
    .set(set)
    .where(
      scopedWhere(runs, {
        orgId: scope.orgId,
        applicationId: scope.applicationId,
        extra,
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
 *
 * `orgId` is mandatory: `llm_usage.run_id` alone is caller-suppliable on the
 * proxy path (`X-Run-Id`), so the aggregate must be structurally inseparable
 * from the tenant — a ledger row whose `org_id` doesn't match the run's org
 * must never inflate that run's cost (CRIT-07). The composite FK
 * `(run_id, org_id) → runs(id, org_id)` enforces the same invariant at the
 * DB level for new rows; this filter covers any pre-constraint legacy rows.
 */
export async function computeRunCost(runId: string, orgId: string): Promise<number> {
  const [llm] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${llmUsage.costUsd}), 0)`,
    })
    .from(llmUsage)
    .where(and(eq(llmUsage.runId, runId), eq(llmUsage.orgId, orgId)));

  return Number(llm?.total ?? 0);
}

/**
 * Minimal org-scoped attribution row for validating a caller-supplied run
 * reference (the llm-proxy `X-Run-Id` header) against the calling principal
 * BEFORE any usage is recorded on it. Returns `null` for an unknown id and
 * for a run outside `orgId` — the caller must treat both identically (404)
 * so a foreign tenant's run id can't be probed for existence. Never use this
 * for reads that return run data to a client.
 */
export async function getRunAttribution(
  orgId: string,
  runId: string,
): Promise<{
  id: string;
  applicationId: string;
  userId: string | null;
  endUserId: string | null;
  apiKeyId: string | null;
} | null> {
  const [row] = await db
    .select({
      id: runs.id,
      applicationId: runs.applicationId,
      userId: runs.userId,
      endUserId: runs.endUserId,
      apiKeyId: runs.apiKeyId,
    })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.orgId, orgId)))
    .limit(1);
  return row ?? null;
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
  // Scheduled / system runs (`actor === null`) read the shared (actor-less)
  // bucket only: the branch always pushes a predicate. Leaving the null
  // branch predicate-less would read EVERY actor's successful runs for this
  // (org, app, package) — cross-actor checkpoint leakage (CRIT-14).
  if (actor) {
    conditions.push(actorFilter(actor, { userId: runs.userId, endUserId: runs.endUserId }));
  } else {
    conditions.push(isNull(runs.userId), isNull(runs.endUserId));
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
    // Historical rows may carry `text`/`text_truncated` keys from the removed
    // #632 report channel; project to the documented output-only shape.
    if (fields.includes("result")) {
      entry.result = projectResultOutput(row.result);
    }
    return entry;
  });
}

/**
 * The given actor's most recent runs in an application (own runs only, newest
 * first) — feeds the chat module's caller-context block. Unlike `getRecentRuns`
 * this spans all packages and all statuses (so failures surface), and returns a
 * minimal wire-shape (snake_case) tuned for the system prompt. Actor isolation
 * is mandatory: a user never sees another actor's runs.
 */
export async function listRecentForActor(
  scope: AppScope,
  actor: Actor | null,
  options: { limit?: number } = {},
): Promise<
  Array<{
    package_id: string;
    status: string;
    run_number: number | null;
    started_at: string | null;
    error: string | null;
  }>
> {
  const limit = options.limit ?? 5;
  const conditions = [eq(runs.orgId, scope.orgId), eq(runs.applicationId, scope.applicationId)];
  if (actor) {
    conditions.push(actorFilter(actor, { userId: runs.userId, endUserId: runs.endUserId }));
  }

  const rows = await db
    .select({
      packageId: runs.packageId,
      status: runs.status,
      runNumber: runs.runNumber,
      startedAt: runs.startedAt,
      error: runs.error,
    })
    .from(runs)
    .where(and(...conditions))
    .orderBy(desc(runs.startedAt))
    .limit(limit);

  return (
    rows
      // Skip runs whose package was deleted (packageId set null on delete) —
      // there is nothing useful to reference in the prompt.
      .filter((row): row is typeof row & { packageId: string } => row.packageId != null)
      .map((row) => ({
        package_id: row.packageId,
        status: row.status,
        run_number: row.runNumber,
        started_at: toISO(row.startedAt),
        // Only surface the error message for non-success runs.
        error: row.status === "success" ? null : (row.error ?? null),
      }))
  );
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

/**
 * Outcome of a boot-phase synthetic heartbeat.
 * - `bumped`       — the run is still booting (no guest events yet, sink
 *                    open); `last_heartbeat_at` was advanced.
 * - `guest-active` — the guest has emitted at least one event; real
 *                    liveness has taken over, stop synthesising.
 * - `closed`       — the sink is closed (run finalised) or the run is gone.
 */
export type BootHeartbeatOutcome = "bumped" | "guest-active" | "closed";

/**
 * Synthetic keep-alive for a run whose guest has not yet posted its first
 * sink event — the boot-window liveness signal the Firecracker remote
 * backend uses so the stall watchdog does not kill a slow-booting microVM
 * before it reports.
 *
 * Reuses the EXACT mechanism the watchdog reads: it bumps
 * `runs.last_heartbeat_at` on an OPEN-sink row (`sink_closed_at IS NULL`),
 * the same column `POST /events/heartbeat`, `PATCH /sink/extend` and event
 * ingestion touch. It is gated to `last_event_sequence = 0` so it only
 * fires during the pre-first-event boot window — once the guest reports,
 * real events keep the run alive and this returns `guest-active` to stop
 * the pump.
 */
export async function recordBootHeartbeat(runId: string): Promise<BootHeartbeatOutcome> {
  const bumped = await db
    .update(runs)
    .set({ lastHeartbeatAt: new Date() })
    .where(and(eq(runs.id, runId), isNull(runs.sinkClosedAt), eq(runs.lastEventSequence, 0)))
    .returning({ id: runs.id });
  if (bumped.length > 0) return "bumped";

  // Nothing bumped — distinguish "guest is now reporting" from "run closed
  // / gone" so the caller knows whether to keep the pump alive.
  const [row] = await db
    .select({ closed: runs.sinkClosedAt, seq: runs.lastEventSequence })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  if (!row || row.closed !== null) return "closed";
  return "guest-active";
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
      // Raw input snapshot (file fields keep their `upload://` URIs) — read
      // by the `rerun_from` path to replay the same input on a new run.
      input: runs.input,
    })
    .from(runs)
    .where(and(...conditions))
    .limit(1);
  return row ?? null;
}

export async function deletePackageRuns(scope: AppScope, packageId: string): Promise<number> {
  // Resolve the run ids first so the documents they contain can be
  // detach-or-deleted BEFORE the runs are removed — the runs' FK cascade would
  // otherwise destroy `documents` rows (and their `document_links`) a live
  // consumer still needs, silently amputating a rerun's inputs.
  const runRows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      scopedWhere(runs, {
        orgId: scope.orgId,
        applicationId: scope.applicationId,
        extra: [eq(runs.packageId, packageId)],
      }),
    );
  if (runRows.length === 0) return 0;
  const runIds = runRows.map((r) => r.id);

  // Contained-documents teardown in its own transaction, then the runs delete.
  // Separate statements: a crash between them leaves the docs already handled
  // (detached or deleted) and the runs still present — the next delete attempt
  // re-runs both idempotently (re-handling finds nothing left to detach/delete,
  // the runs delete finishes the job).
  await detachOrDeleteContainedDocuments({ runIds });

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
  actor: Actor | null = null,
): Promise<RunListPage> {
  const [countRow] = await db.select({ count: count() }).from(runs).where(filter);

  const rows = await db
    .select(enrichedRunSelect(actor))
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
    actor?: Actor | null;
  } = {},
) {
  const { limit = 50, offset = 0, endUserId, actor = null } = options;
  const conditions = [
    eq(runs.packageId, packageId),
    eq(runs.orgId, scope.orgId),
    eq(runs.applicationId, scope.applicationId),
  ];
  if (endUserId) {
    conditions.push(eq(runs.endUserId, endUserId));
  }
  return listRunsWithFilter(and(...conditions)!, limit, offset, actor);
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
  actor?: Actor | null;
}

export async function listGlobalRuns(
  scope: AppScope,
  options: ListGlobalRunsOptions = {},
): Promise<RunListPage> {
  const {
    limit = 50,
    offset = 0,
    kind,
    status,
    startDate,
    endDate,
    endUserId,
    actor = null,
  } = options;

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
    .select(enrichedRunSelect(actor))
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
  options: { limit?: number; offset?: number; actor?: Actor | null } = {},
) {
  const { limit = 20, offset = 0, actor = null } = options;
  return listRunsWithFilter(
    scopedWhere(runs, {
      orgId: scope.orgId,
      applicationId: scope.applicationId,
      extra: [eq(runs.scheduleId, scheduleId)],
    })!,
    limit,
    offset,
    actor,
  );
}

export async function getRunFull(scope: AppScope, id: string, actor: Actor | null = null) {
  const conditions = [
    eq(runs.id, id),
    eq(runs.orgId, scope.orgId),
    eq(runs.applicationId, scope.applicationId),
  ];

  const [row] = await db
    .select({
      ...enrichedRunSelect(actor),
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
 * `minLevel` filters by minimum severity using the fixed `run_logs.level`
 * domain (`debug < info < warn < error`): `minLevel: "info"` returns
 * info/warn/error rows and skips the debug breadcrumbs. Implemented as an
 * `IN (...)` filter so the check constraint's domain stays the single
 * source of truth — no numeric severity column needed.
 *
 * Org-scoped by design — `run_logs` has no `applicationId` column, and
 * the object-args shape is the module-facing public contract. App-scoped
 * callers must verify run ownership via `getRun(scope, runId)` first.
 */
export const RUN_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type RunLogLevel = (typeof RUN_LOG_LEVELS)[number];

export async function listRunLogs(args: {
  runId: string;
  orgId: string;
  /**
   * Page-size cap — ALWAYS applied. Defaults to 1000 when omitted so no
   * caller can accidentally pull an unbounded log history; page with
   * `sinceId` for longer runs.
   */
  limit?: number;
  order?: "asc" | "desc";
  sinceId?: number;
  minLevel?: RunLogLevel;
}) {
  const { runId, orgId, limit = 1000, order = "asc", sinceId, minLevel } = args;
  if (sinceId !== undefined && order === "desc") {
    throw new Error("listRunLogs: sinceId is not supported with order=desc");
  }
  const filters = [eq(runLogs.runId, runId), eq(runLogs.orgId, orgId)];
  if (sinceId !== undefined) filters.push(gt(runLogs.id, sinceId));
  if (minLevel !== undefined && minLevel !== "debug") {
    filters.push(inArray(runLogs.level, RUN_LOG_LEVELS.slice(RUN_LOG_LEVELS.indexOf(minLevel))));
  }
  const q = db
    .select()
    .from(runLogs)
    .where(and(...filters))
    .orderBy(order === "desc" ? desc(runLogs.id) : runLogs.id);
  const rows = await q.limit(limit);
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
