// SPDX-License-Identifier: Apache-2.0

import { createQueue } from "../infra/queue/index.ts";
import type { JobQueue, QueueJob } from "../infra/queue/index.ts";
import { getCache } from "../infra/index.ts";
import { and, eq, asc, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { schedules, endUsers, runs, notifications } from "@appstrate/db/schema";
import { activeRunStatusValues } from "@appstrate/core/run-status";
import { resolveSpaceRole, spacePermissions } from "../lib/space-role.ts";
import { loadSpaceAccess } from "../lib/space-lookup.ts";
import { batchLoadUserNames } from "../lib/user-helpers.ts";
import { logger } from "../lib/logger.ts";
import type { ScheduleWireDto, EnrichedSchedule } from "@appstrate/shared-types";
import { createFailedRun } from "./state/runs.ts";
import { emitEvent } from "../lib/modules/module-loader.ts";
import {
  prepareAndExecuteRun,
  resolveRunPreflight,
  extractRunAgentDenorm,
} from "./run-pipeline.ts";
import { getSpacePackageSettings } from "./space-packages.ts";
import { agentExecutionBlock } from "../lib/package-access.ts";
import { resolveAndValidateScheduleInput } from "./input-resolution.ts";
import { withoutLockedFields } from "@appstrate/core/input-resolution";
import { getErrorMessage } from "@appstrate/core/errors";
import type { ConnectionOverrides } from "@appstrate/core/integration";
import { toLaunchOverrides } from "./integration-connection-resolver.ts";
import { asRecordOrNull } from "@appstrate/core/safe-json";
import { getPackage, packageExists } from "./package-catalog.ts";
import { resolveAgentRunVersion } from "./agent-version-resolver.ts";
import type { LoadedPackage } from "../types/index.ts";
import { ApiError, conflict, internalError, invalidRequest } from "../lib/errors.ts";
import { scopedWhere, type Tx } from "../lib/db-helpers.ts";
import { computeNextRun } from "../lib/cron.ts";
import { actorFromIds, actorMatch, type Actor } from "../lib/actor.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { setQueueDepthSource } from "@appstrate/core/telemetry";
import type { ModelGenerationSettings } from "@appstrate/core/model-generation";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScheduleJobData {
  scheduleId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Drizzle schedule row to the wire DTO. Universal DB-convention
 * fields (createdAt, *Id, userId) stay camelCase; domain-specific fields
 * use snake_case.
 */
function toSchedule(row: typeof schedules.$inferSelect): ScheduleWireDto {
  return {
    id: row.id,
    packageId: row.packageId,
    userId: row.userId,
    endUserId: row.endUserId,
    orgId: row.orgId,
    spaceId: row.spaceId,
    name: row.name,
    enabled: row.enabled,
    disabled_reason: row.disabledReason,
    cron_expression: row.cronExpression,
    timezone: row.timezone,
    input: asRecordOrNull(row.input),
    generation_config_override: row.generationConfigOverride ?? null,
    model_id_override: row.modelIdOverride,
    proxy_id_override: row.proxyIdOverride,
    version_override: row.versionOverride,
    connection_overrides: (row.connectionOverrides as ConnectionOverrides | null) ?? null,
    dependency_overrides: (row.dependencyOverrides as Record<string, string> | null) ?? null,
    last_run_at: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    next_run_at: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    createdAt: row.createdAt!.toISOString(),
    updatedAt: row.updatedAt!.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// BullMQ queue & worker
// ---------------------------------------------------------------------------

const QUEUE_NAME = "schedules";

let scheduleQueue: JobQueue<ScheduleJobData> | null = null;

async function getQueue(): Promise<JobQueue<ScheduleJobData>> {
  if (!scheduleQueue) {
    scheduleQueue = await createQueue<ScheduleJobData>(QUEUE_NAME);
  }
  return scheduleQueue;
}

/** Upsert a repeatable job scheduler for a schedule row. */
async function upsertScheduleJob(row: typeof schedules.$inferSelect): Promise<void> {
  await (
    await getQueue()
  ).upsertScheduler(
    row.id,
    { pattern: row.cronExpression, tz: row.timezone },
    { name: "execute-agent", data: { scheduleId: row.id } },
  );
}

/** Remove a repeatable job scheduler. */
async function removeScheduleJob(scheduleId: string): Promise<void> {
  await (await getQueue()).removeScheduler(scheduleId);
}

/** Remove disabled schedules' jobs. Best-effort: a surviving job's fire removes itself. */
export async function removeScheduleJobs(scheduleIds: readonly string[]): Promise<void> {
  for (const scheduleId of scheduleIds) {
    try {
      await removeScheduleJob(scheduleId);
    } catch (err) {
      logger.error("Failed to remove the job of a disabled schedule", {
        scheduleId,
        error: getErrorMessage(err),
      });
    }
  }
}

/**
 * Fire-time actor revalidation (CRIT-13). The schedule row only cascades on
 * user-ACCOUNT or org deletion — a member removed from the org keeps their
 * `user` row (multi-org), so their schedules would otherwise keep firing as
 * them. Re-check on EVERY fire that the row's actor still holds the
 * identity the schedule runs as: a member must still belong to the
 * schedule's org and hold agents:run in its space; an end-user must still
 * exist in the schedule's space.
 */
async function isScheduleActorValid(
  actor: Actor,
  orgId: string,
  spaceId: string,
): Promise<boolean> {
  if (actor.type === "user") {
    // All three inputs in one statement: a fire has no admission to pin the org
    // role at (RBAC spec §4.4).
    const access = await loadSpaceAccess(spaceId, orgId, actor.id);
    if (!access?.orgRole) return false;
    // The frozen actor IS the caller here: a schedule in a personal space runs
    // as its owner, and stops the moment they are no longer the owner
    // (RBAC spec §3.6).
    return spacePermissions(
      resolveSpaceRole(access.orgRole, access.space, access.member, actor.id),
    ).has("agents:run");
  }
  const [row] = await db
    .select({ id: endUsers.id })
    .from(endUsers)
    .where(and(eq(endUsers.id, actor.id), eq(endUsers.spaceId, spaceId)))
    .limit(1);
  return row !== undefined;
}

function invalidScheduleActorReason(actor: Actor): string {
  return actor.type === "user"
    ? "its actor is not a member of this organization or cannot run agents in this space"
    : "its end-user actor does not exist in this space";
}

/**
 * The fire-time actor check, run when an armed schedule is written: an actor who could never fire
 * it is refused before any connection is resolved on their behalf.
 */
export async function assertScheduleActorValid(
  actor: Actor,
  orgId: string,
  spaceId: string,
): Promise<void> {
  if (!(await isScheduleActorValid(actor, orgId, spaceId))) {
    throw invalidRequest(`Schedule refused: ${invalidScheduleActorReason(actor)}`, "actor");
  }
}

/** Whether this call disabled it (false: someone already had). */
async function disableScheduleForInvalidActor(scheduleId: string): Promise<boolean> {
  const disabled = await db
    .update(schedules)
    .set({
      enabled: false,
      disabledReason: "actor_invalid",
      nextRunAt: null,
      updatedAt: new Date(),
    })
    // A user who disabled it while this fire ran keeps their reason.
    .where(and(eq(schedules.id, scheduleId), eq(schedules.enabled, true)))
    .returning({ id: schedules.id });
  await removeScheduleJobs([scheduleId]);
  return disabled.length > 0;
}

/**
 * Same-instance in-flight guard: the set of schedule-fire occurrence keys this
 * process is currently executing. Prevents a second concurrent delivery of the
 * SAME occurrence on this instance from double-triggering (belt-and-suspenders
 * with the cross-instance {@link claimScheduleFire} marker below).
 */
const inFlightFires = new Set<string>();

/** How long a fire-claim marker lives — must outlive the job's retry window. */
const FIRE_CLAIM_TTL_SECONDS = 3600;

/**
 * Claim a schedule-fire occurrence exactly once across instances/restarts.
 * `fireKey` is `(scheduleId, fireAt)` — the BullMQ repeatable `job.id` encodes
 * the fire timestamp, so two deliveries (or a retry) of the same occurrence
 * share it. Returns `true` when THIS call won the claim (SET NX succeeded),
 * `false` when the occurrence was already fired. On a cache error we fail OPEN
 * (return `true`) — losing at-most-once dedup is preferable to silently
 * dropping a scheduled run.
 */
async function claimScheduleFire(fireKey: string): Promise<boolean> {
  try {
    const cache = await getCache();
    return await cache.set(`schedule-fired:${fireKey}`, "1", {
      nx: true,
      ttlSeconds: FIRE_CLAIM_TTL_SECONDS,
    });
  } catch (err) {
    logger.warn("Schedule fire-claim cache error, proceeding without dedup", {
      fireKey,
      error: getErrorMessage(err),
    });
    return true;
  }
}

/** Process a scheduled job. */
async function handleScheduleJob(job: QueueJob<ScheduleJobData>): Promise<void> {
  const { scheduleId } = job.data;

  // Idempotency key for this fire occurrence: (scheduleId, fireAt). The
  // repeatable job.id encodes the scheduled fire time, so duplicate deliveries
  // and BullMQ retries of the same occurrence collapse to one key.
  const fireKey = `${scheduleId}:${job.id}`;

  if (inFlightFires.has(fireKey)) {
    logger.warn("Schedule fire already in-flight on this instance, skipping duplicate", {
      scheduleId,
      jobId: job.id,
    });
    return;
  }
  inFlightFires.add(fireKey);
  try {
    // Cross-instance / cross-restart guard: claim the occurrence exactly once.
    // A duplicate delivery or a retry after the run was already triggered must
    // NOT create a second run. The claim runs only after the row is read, so a
    // failed read leaves the occurrence unconsumed and the job fails loudly.
    const claim = async () => {
      if (await claimScheduleFire(fireKey)) return true;
      logger.warn("Schedule fire already claimed, skipping duplicate", {
        scheduleId,
        jobId: job.id,
      });
      return false;
    };
    const fired = await triggerScheduledRun(scheduleId, claim);
    if (!fired) return;

    // The trigger may have disabled the schedule (invalid actor), and a write may land after its
    // read, so the UPDATE itself decides: a nextRunAt only onto a row still enabled on the cron it
    // was computed from, else the concurrent writer's value stands. Bookkeeping only: `updatedAt`
    // is the write token of `updateSchedule`, so bumping it would 409 an overlapping PATCH.
    const nextRun = computeNextRun(fired.cronExpression, fired.timezone);
    await db
      .update(schedules)
      .set({
        lastRunAt: new Date(),
        nextRunAt: sql`CASE WHEN ${schedules.enabled}
          AND ${schedules.cronExpression} = ${fired.cronExpression}
          AND ${schedules.timezone} = ${fired.timezone}
          THEN ${nextRun?.toISOString() ?? null}::timestamptz ELSE ${schedules.nextRunAt} END`,
      })
      .where(eq(schedules.id, scheduleId));
  } finally {
    inFlightFires.delete(fireKey);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Sync enabled schedules into the queue, THEN start the worker: no fire reads stale job data. */
export async function initScheduleWorker(): Promise<void> {
  const queue = await getQueue();

  // Feed the observability queue-depth gauge. Stored unconditionally — the
  // gauge only pulls it when telemetry is enabled, otherwise it's never read.
  setQueueDepthSource(() => queue.count());

  const rows = await db.select().from(schedules).where(eq(schedules.enabled, true));

  let synced = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (!(await packageExists(row.packageId))) {
        logger.warn("Schedule references missing package, skipping", {
          scheduleId: row.id,
          packageId: row.packageId,
        });
        continue;
      }
      await upsertScheduleJob(row);
      synced++;
    } catch (err) {
      failed++;
      logger.error("Failed to sync schedule at boot, skipping", {
        scheduleId: row.id,
        packageId: row.packageId,
        error: getErrorMessage(err),
      });
    }
  }

  queue.process(
    async (job) => {
      await handleScheduleJob(job);
    },
    // IO-bound: concurrency is safe; the limiter is a global abuse backstop, not serialisation.
    { concurrency: 10, limiter: { max: 30, duration: 60_000 } },
  );

  if (synced > 0 || failed > 0) {
    logger.info("Schedule worker initialized", {
      schedulersSynced: synced,
      schedulersFailed: failed,
    });
  }
}

/** Shutdown schedule worker and queue. */
export async function shutdownScheduleWorker(): Promise<void> {
  await scheduleQueue?.shutdown();
  scheduleQueue = null;
  logger.info("Schedule worker stopped");
}

// ---------------------------------------------------------------------------
// Run trigger
// ---------------------------------------------------------------------------

/**
 * Fire one scheduled run from the schedule row, read now; any `ApiError` becomes a visible failed
 * run (`failSchedule()`). Returns the cron the fire read, or `null` when the row is gone or
 * disabled (its job is removed) or `claim` refuses the occurrence. A failed read throws before
 * `claim`, leaving the occurrence unconsumed for the job's failure to report.
 */
export async function triggerScheduledRun(
  scheduleId: string,
  claim: () => Promise<boolean> = async () => true,
): Promise<Pick<typeof schedules.$inferSelect, "cronExpression" | "timezone"> | null> {
  const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId)).limit(1);
  if (!row?.enabled) {
    logger.info("Schedule deleted or disabled since its job was armed, removing the job", {
      scheduleId,
    });
    await removeScheduleJobs([scheduleId]);
    return null;
  }
  if (!(await claim())) return null;

  const { packageId, orgId, spaceId } = row;
  // `package_schedules_exactly_one_actor` guarantees exactly one of the two ids.
  const actor = actorFromIds(row.userId, row.endUserId)!;
  const input = asRecordOrNull(row.input) ?? undefined;
  const versionOverride = row.versionOverride ?? undefined;
  const dependencyOverrides = row.dependencyOverrides ?? null;

  // Populated once the agent loads so every failSchedule() call can
  // denormalize `agent_scope` / `agent_name` onto the failed run row.
  let agentDenorm: { scope: string | null; name: string | null } | null = null;

  /** Create a failed run record + emit onRunStatusChange so modules (webhooks, …) can notify. */
  async function failSchedule(error: string): Promise<void> {
    const runId = `run_${crypto.randomUUID()}`;
    try {
      await createFailedRun(
        { orgId, spaceId },
        runId,
        packageId,
        actor,
        error,
        scheduleId,
        agentDenorm ?? undefined,
      );
      void emitEvent("onRunStatusChange", {
        orgId,
        runId,
        packageId,
        spaceId,
        status: "failed",
        extra: { error },
      });
    } catch (err) {
      logger.error("Failed to create failed schedule run record", {
        scheduleId,
        runId,
        error: getErrorMessage(err),
      });
    }
  }

  try {
    // Revalidate the actor BEFORE any preflight (CRIT-13); a refusal is a visible failed run (#735).
    if (!(await isScheduleActorValid(actor, orgId, spaceId))) {
      logger.warn("Schedule actor is no longer valid — disabling schedule", {
        scheduleId,
        packageId,
        orgId,
        spaceId,
        actorType: actor.type,
        actorId: actor.id,
      });
      const disabled = await disableScheduleForInvalidActor(scheduleId);
      await failSchedule(
        `Schedule ${disabled ? "disabled" : "refused"}: ${invalidScheduleActorReason(actor)}`,
      );
      return row;
    }

    const launchOverrides = toLaunchOverrides(row.connectionOverrides, "schedule_override");

    const draftAgent = await getPackage(packageId, orgId);
    if (!draftAgent) {
      logger.warn("Package not found, skipping schedule", { packageId, scheduleId });
      await failSchedule(`Package '${packageId}' not found`);
      return row;
    }
    agentDenorm = extractRunAgentDenorm(draftAgent);

    // EXECUTION gate, at FIRE time — not at create time. Whether a space runs a
    // package is a property of the SPACE and it can change after the schedule
    // was written, exactly like the integration activation the readiness pass
    // below already re-checks (`integration_not_active`). The authority
    // arguments that freeze the actor's draft rights and the connection
    // overrides do not apply: those are properties of the principal, settled
    // when they proved them. "Switch this agent off for a week" has to stop the
    // cron too, or deactivating is a cosmetic filter on the pages a human looks
    // at while the agent keeps running on the space's credentials and the
    // organization's LLM budget. Revoking the SHARE that placed it here has to
    // stop it for the same reason — the same predicate the three HTTP doors
    // ask, so the one caller nobody is watching is not the permissive one.
    //
    // A VISIBLE failed run, and the schedule left ARMED — the same channel as a
    // missing package below, deliberately not the invalid-actor channel, which
    // also disables the schedule: an actor who left the org is not coming back,
    // whereas switching the agent back on (or offering it again) must let the
    // next tick run it. The two refusals name their own cause: "not placed" and
    // "not active" are repaired by different acts, and a message that named the
    // wrong one would send the operator to the wrong page.
    const executionBlock = await agentExecutionBlock({ orgId, spaceId }, packageId);
    if (executionBlock) {
      logger.warn("Agent cannot execute in this space, skipping schedule", {
        scheduleId,
        packageId,
        orgId,
        spaceId,
        block: executionBlock,
      });
      await failSchedule(
        executionBlock === "not_placed"
          ? `Agent '${packageId}' is not placed in space '${spaceId}'. ` +
              `Share it into that space via POST /api/packages/${packageId}/shares, ` +
              `or move this schedule to a space the agent is placed in.`
          : `Agent '${packageId}' is not active in space '${spaceId}'. ` +
              `Activate it via POST /api/spaces/${spaceId}/packages to resume this schedule.`,
      );
      return row;
    }

    // Same resolver as a manual run: the schedule's own `version_override`, or
    // the latest published version when it has none. No authority check — the
    // principal who created the schedule proved it then (`routes/schedules.ts`),
    // and this path has no Hono context to re-ask with. Every resolution failure
    // (missing version, unreadable archive, storage outage) produces a visible
    // failed run.
    let agent: LoadedPackage;
    let overrideVersionLabel: string | undefined;
    try {
      const resolved = await resolveAgentRunVersion(draftAgent, versionOverride);
      agent = resolved.agent;
      overrideVersionLabel = resolved.overrideVersionLabel;
    } catch (err) {
      if (err instanceof ApiError) {
        logger.warn("Schedule version resolution failed, skipping run", {
          scheduleId,
          packageId,
          code: err.code,
          detail: err.message,
        });
        await failSchedule(err.message);
        return row;
      }
      // Storage/SDK/programming error text stays in the log: the run row is user-visible.
      logger.error("Schedule version resolution threw, recording a failed run", {
        scheduleId,
        packageId,
        error: getErrorMessage(err),
      });
      await failSchedule("The scheduled version could not be loaded (internal error)");
      return row;
    }

    // Per-space settings: editor defaults + locked fields for the input
    // resolution below, and the model/proxy this fire launches with.
    const packageSettings = await getSpacePackageSettings({ orgId, spaceId }, packageId);

    // Shared preflight: validate readiness
    try {
      await resolveRunPreflight({
        agent,
        spaceId,
        orgId,
        actor,
        // Schedule freezes per-integration picks at create time; forward
        // them so readiness honours the same disambiguation the run
        // pipeline will use a few lines down (matches the "single source
        // of truth" intent of overrides).
        launchOverrides,
        // `package_schedules.dependency_overrides` — the same value forwarded
        // into `prepareAndExecuteRun` below. Without it a schedule pinned to a
        // working copy would have its readiness judged against the published
        // version it is deliberately bypassing, and `failSchedule` would stop
        // the schedule over a disagreement it invented.
        dependencyOverrides,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        logger.warn("Agent readiness check failed, skipping schedule", {
          scheduleId,
          packageId,
          code: err.code,
          detail: err.message,
        });
        await failSchedule(err.message);
        return row;
      }
      logger.error("Unexpected error during schedule preflight", {
        scheduleId,
        packageId,
        error: getErrorMessage(err),
      });
      await failSchedule(`Preflight error: ${getErrorMessage(err)}`);
      return row;
    }

    // Resolve this fire's input through the same layers as a request run —
    // author defaults < editor defaults < the schedule's frozen values — and
    // validate the result, because both the layers and the schema can drift
    // after the schedule was written (a field locked since, a tightened
    // schema).
    //
    // The pair comes from `resolveAndValidateScheduleInput`, which documents
    // itself as existing for exactly three call sites — create, update and this
    // one — and names the drift that writing it out per site produced. This
    // site had re-inlined it anyway. What stays HERE is the only part that is
    // the scheduler's own: the failure CHANNEL. A cron fire has no caller to
    // answer, so a refusal becomes `failSchedule` + a visible failed run rather
    // than a throw into the worker.
    let resolvedInput: Record<string, unknown>;
    try {
      const resolution = resolveAndValidateScheduleInput({
        inputSchema: agent.manifest.input?.schema,
        editorDefaults: packageSettings.values,
        lockedFields: packageSettings.locked,
        input,
      });
      if (resolution.errors) {
        logger.warn("Scheduled input validation failed, skipping run", {
          scheduleId,
          packageId,
          errors: resolution.errors,
        });
        await failSchedule(
          `Input validation failed: ${resolution.errors.map((e) => e.message).join(", ")}`,
        );
        return row;
      }
      resolvedInput = resolution.resolved;
    } catch (err) {
      // `locked_input_field` — the one refusal resolution itself raises.
      if (err instanceof ApiError) {
        logger.warn("Schedule input no longer resolvable", {
          scheduleId,
          packageId,
          code: err.code,
          detail: err.message,
        });
        await failSchedule(err.message);
        return row;
      }
      throw err;
    }

    const runId = `run_${crypto.randomUUID()}`;

    const finalModelId = row.modelIdOverride ?? packageSettings.modelId;
    const finalProxyId = row.proxyIdOverride ?? packageSettings.proxyId;

    try {
      await prepareAndExecuteRun({
        runId,
        agent,
        orgId,
        actor,
        input: resolvedInput,
        modelId: finalModelId,
        generationConfig: packageSettings.generationConfig,
        generationConfigOverride: row.generationConfigOverride ?? null,
        proxyId: finalProxyId,
        overrideVersionLabel,
        scheduleId,
        spaceId,
        launchOverrides,
        dependencyOverrides,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        logger.warn("Scheduled run pipeline failed", {
          scheduleId,
          packageId,
          orgId,
          code: err.code,
          detail: err.message,
        });
        await failSchedule(err.message);
        return row;
      }
      throw err;
    }

    logger.info("Triggering scheduled run", {
      runId,
      packageId,
      scheduleId,
      orgId,
    });
  } catch (err) {
    logger.error("Failed to trigger schedule", {
      scheduleId,
      packageId,
      error: getErrorMessage(err),
    });
  }
  return row;
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

export async function listSchedules(
  scope: SpaceScope,
  viewer: Actor | null,
  visibility: SQL | undefined,
): Promise<EnrichedSchedule[]> {
  const rows = await db
    .select()
    .from(schedules)
    .where(scopedWhere(schedules, { orgId: scope.orgId, spaceId: scope.spaceId }))
    .orderBy(asc(schedules.createdAt));
  return enrichSchedules(rows.map(toSchedule), scope.orgId, viewer, visibility);
}

export async function listPackageSchedules(
  scope: SpaceScope,
  packageId: string,
  viewer: Actor | null,
  visibility: SQL | undefined,
): Promise<EnrichedSchedule[]> {
  const rows = await db
    .select()
    .from(schedules)
    .where(
      scopedWhere(schedules, {
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        extra: [eq(schedules.packageId, packageId)],
      }),
    )
    .orderBy(asc(schedules.createdAt));
  return enrichSchedules(rows.map(toSchedule), scope.orgId, viewer, visibility);
}

/** The bare schedule row, before any enrichment — what a write path reads to diff against. */
async function loadSchedule(id: string, scope: SpaceScope): Promise<ScheduleWireDto | null> {
  const rows = await db
    .select()
    .from(schedules)
    .where(
      scopedWhere(schedules, {
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        extra: [eq(schedules.id, id)],
      }),
    )
    .limit(1);
  return rows[0] ? toSchedule(rows[0]) : null;
}

export async function getSchedule(
  id: string,
  scope: SpaceScope,
  viewer: Actor | null,
  visibility: SQL | undefined,
): Promise<EnrichedSchedule | null> {
  const schedule = await loadSchedule(id, scope);
  if (!schedule) return null;
  const [enriched] = await enrichSchedules([schedule], schedule.orgId, viewer, visibility);
  return enriched ?? null;
}

/** Per-schedule run counters served with the schedule itself (see {@link loadScheduleRunStats}). */
interface ScheduleRunStats {
  runningRuns: number;
  unreadCount: number;
  lastRunNumber: number;
}

const EMPTY_RUN_STATS: ScheduleRunStats = { runningRuns: 0, unreadCount: 0, lastRunNumber: 0 };

/**
 * Enrichment fields for the (unreachable in practice) branch where the
 * enrichment query returns no row for a schedule we just wrote. Spread rather
 * than re-listed at each call site so a new `EnrichedSchedule` field cannot be
 * added to the happy path alone.
 */
const UNENRICHED_SCHEDULE_FIELDS = {
  actor_name: null,
  actor_type: null,
  running_runs: 0,
  unread_count: 0,
  last_run_number: 0,
} satisfies Omit<EnrichedSchedule, keyof ScheduleWireDto>;

/**
 * The three run counters every schedule card shows — active runs, unread runs
 * for the VIEWER, and the highest run number — as ONE grouped query over the
 * whole list.
 *
 * These used to be derived client-side: each card fetched
 * `GET /api/schedules/:id/runs` (up to 20 enriched rows, each with its own
 * unread EXISTS and file subqueries) purely to count three things, so a
 * dashboard listing N schedules issued N extra HTTP requests and ~2N SQL
 * queries. Serving them from the list the cards already have removes the fan-out
 * entirely.
 *
 * Two deliberate semantics:
 *  - the counts span ALL of a schedule's runs, not the most recent page. The
 *    per-card version counted within the 20 rows it happened to fetch, so a
 *    schedule with 25 unread runs reported 20.
 *  - `unreadCount` is scoped to the VIEWER (`actorMatch` on the polymorphic
 *    recipient tuple), never to the schedule's own actor — the same rule
 *    `unreadForActor` applies to run lists, so a member and an end-user never
 *    observe each other's read state. A null viewer (no actor context) reports
 *    0: unread is a recipient-side concept.
 *
 * `visibility` is the caller's run-read predicate (`runVisibilityFilter`), so
 * the counters span exactly the runs the caller may open from the card. Without
 * it a member without `runs:read-all` would read "3 running" off a colleague's
 * schedule and find an empty run list behind it.
 */
async function loadScheduleRunStats(
  scheduleIds: string[],
  orgId: string,
  viewer: Actor | null,
  visibility: SQL | undefined,
): Promise<Map<string, ScheduleRunStats>> {
  if (scheduleIds.length === 0) return new Map();

  const unreadPredicate = viewer
    ? sql`exists (
        select 1 from ${notifications}
        where ${notifications.runId} = ${runs.id}
          and ${actorMatch(viewer, {
            typeCol: notifications.recipientType,
            idCol: notifications.recipientId,
          })}
          and ${notifications.readAt} is null
      )`
    : sql`false`;

  const rows = await db
    .select({
      scheduleId: runs.scheduleId,
      runningRuns: sql<string>`count(*) filter (where ${inArray(runs.status, [
        ...activeRunStatusValues,
      ])})`,
      unreadCount: sql<string>`count(*) filter (where ${unreadPredicate})`,
      lastRunNumber: sql<string>`coalesce(max(${runs.runNumber}), 0)`,
    })
    .from(runs)
    // `scheduleId` is already unique per org, but the org filter keeps the read
    // tenant-scoped by construction rather than by trusting the id list.
    .where(and(eq(runs.orgId, orgId), inArray(runs.scheduleId, scheduleIds), visibility))
    .groupBy(runs.scheduleId);

  // postgres.js returns count()/max() as numeric STRINGS — coerce here so the
  // wire DTO carries real numbers.
  return new Map(
    rows
      .filter((r): r is typeof r & { scheduleId: string } => r.scheduleId !== null)
      .map((r) => [
        r.scheduleId,
        {
          runningRuns: Number(r.runningRuns),
          unreadCount: Number(r.unreadCount),
          lastRunNumber: Number(r.lastRunNumber),
        },
      ]),
  );
}

/**
 * Enrich schedules with the display name of the actor (member or end-user)
 * each schedule runs as, plus the viewer-scoped run counters the list UI would
 * otherwise fetch per row. Batches every lookup across the whole list.
 *
 * @param viewer Actor the response is being rendered for — scopes
 *   `unread_count` only. Null when there is no actor context.
 * @param visibility Caller's run-read predicate — scopes `running_runs` and
 *   `last_run_number` (see {@link loadScheduleRunStats}).
 */
async function enrichSchedules(
  schedules: ScheduleWireDto[],
  orgId: string,
  viewer: Actor | null,
  visibility: SQL | undefined,
): Promise<EnrichedSchedule[]> {
  if (schedules.length === 0) return [];

  const userIds = [...new Set(schedules.map((s) => s.userId).filter((id): id is string => !!id))];
  const endUserIds = [
    ...new Set(schedules.map((s) => s.endUserId).filter((id): id is string => !!id)),
  ];

  const [userNameMap, endUserRows, runStats] = await Promise.all([
    batchLoadUserNames(userIds),
    endUserIds.length > 0
      ? db
          .select({
            id: endUsers.id,
            name: sql<string | null>`coalesce(${endUsers.name}, ${endUsers.externalId})`,
          })
          .from(endUsers)
          .where(inArray(endUsers.id, endUserIds))
      : Promise.resolve([] as { id: string; name: string | null }[]),
    loadScheduleRunStats(
      schedules.map((s) => s.id),
      orgId,
      viewer,
      visibility,
    ),
  ]);
  const endUserNameMap = new Map(endUserRows.map((r) => [r.id, r.name]));

  return schedules.map((schedule) => {
    let actorName: string | null = null;
    let actorType: "user" | "end_user" | null = null;
    if (schedule.userId) {
      actorType = "user";
      actorName = userNameMap.get(schedule.userId) ?? null;
    } else if (schedule.endUserId) {
      actorType = "end_user";
      actorName = endUserNameMap.get(schedule.endUserId) ?? null;
    }
    // A schedule that never fired has no `runs` rows, hence no group — zeroes.
    const stats = runStats.get(schedule.id) ?? EMPTY_RUN_STATS;
    return {
      ...schedule,
      actor_name: actorName,
      actor_type: actorType,
      running_runs: stats.runningRuns,
      unread_count: stats.unreadCount,
      last_run_number: stats.lastRunNumber,
    };
  });
}

export async function createSchedule(
  scope: SpaceScope,
  packageId: string,
  actor: Actor,
  data: {
    name?: string;
    cronExpression: string;
    timezone?: string;
    input?: Record<string, unknown>;
    modelIdOverride?: string | null;
    generationConfigOverride?: ModelGenerationSettings | null;
    proxyIdOverride?: string | null;
    versionOverride?: string | null;
    connectionOverrides?: ConnectionOverrides | null;
    dependencyOverrides?: Record<string, string> | null;
  },
): Promise<EnrichedSchedule> {
  const id = `sched_${crypto.randomUUID()}`;
  const tz = data.timezone || "UTC";

  // Compute next run (cron parsing only)
  const nextRun = computeNextRun(data.cronExpression, tz);

  const [row] = await db
    .insert(schedules)
    .values({
      id,
      packageId,
      userId: actor.type === "user" ? actor.id : null,
      endUserId: actor.type === "end_user" ? actor.id : null,
      orgId: scope.orgId,
      spaceId: scope.spaceId,
      name: data.name ?? null,
      enabled: true,
      cronExpression: data.cronExpression,
      timezone: tz,
      input: data.input ?? null,
      modelIdOverride: data.modelIdOverride ?? null,
      generationConfigOverride: data.generationConfigOverride ?? null,
      proxyIdOverride: data.proxyIdOverride ?? null,
      versionOverride: data.versionOverride ?? null,
      connectionOverrides: data.connectionOverrides ?? null,
      dependencyOverrides: data.dependencyOverrides ?? null,
      nextRunAt: nextRun ?? null,
    })
    .returning();

  if (!row) {
    throw internalError();
  }
  const schedule = toSchedule(row);

  await upsertScheduleJob(row);

  // Same EnrichedSchedule serializer as getSchedule/listSchedules, so the
  // create response matches the GET detail shape (actor_name/actor_type).
  // Neither a viewer nor a visibility predicate is needed here: the schedule
  // was just created, so it has no runs and every counter is zero for anyone.
  const [enriched] = await enrichSchedules([schedule], scope.orgId, null, undefined);
  return enriched ?? { ...schedule, ...UNENRICHED_SCHEDULE_FIELDS };
}

/** The caller's read of the row a write is judged against: the `updatedAt` token + fallbacks. */
export type ScheduleWriteSnapshot = Pick<
  ScheduleWireDto,
  "id" | "updatedAt" | "enabled" | "cron_expression" | "timezone"
>;

/**
 * Merge-update a schedule as a compare-and-set on `expected.updatedAt` (409 otherwise) — not a
 * held lock, which PGlite's single connection would deadlock the caller's `db` checks on.
 */
export async function updateSchedule(
  scope: SpaceScope,
  expected: ScheduleWriteSnapshot,
  data: {
    name?: string;
    cronExpression?: string;
    timezone?: string;
    input?: Record<string, unknown>;
    enabled?: boolean;
    modelIdOverride?: string | null;
    generationConfigOverride?: ModelGenerationSettings | null;
    proxyIdOverride?: string | null;
    versionOverride?: string | null;
    connectionOverrides?: ConnectionOverrides | null;
    dependencyOverrides?: Record<string, string> | null;
    // #738: re-point the schedule's execution identity. When set, overwrites
    // both `userId` and `endUserId` (one non-null, mirroring create). Never
    // clears the actor — the non-null type preserves #735's invariant that a
    // schedule always has an execution identity.
    actor?: Actor;
  },
  /** Actor the response is rendered for — scopes `unread_count` only. */
  viewer: Actor | null,
  /** Caller's run-read predicate — scopes the run counters of the echoed row. */
  visibility: SQL | undefined,
): Promise<EnrichedSchedule> {
  const cronExpr = data.cronExpression ?? expected.cron_expression;
  const tz = data.timezone ?? expected.timezone;
  const enabled = data.enabled ?? expected.enabled;

  // Compute next run (cron parsing only)
  const nextRun = enabled ? computeNextRun(cronExpr, tz) : null;

  const payload: Record<string, unknown> = {
    cronExpression: cronExpr,
    timezone: tz,
    enabled,
    nextRunAt: nextRun ?? null,
    updatedAt: new Date(),
  };
  // Only a switch this write makes is the user's: re-sending the current state
  // (the edit form always does) keeps a system disable's reason.
  if (enabled !== expected.enabled) payload.disabledReason = enabled ? null : "user";
  if (data.name !== undefined) payload.name = data.name;
  if (data.input !== undefined) payload.input = data.input;
  // Explicit `null` clears the override; `undefined` leaves it untouched.
  if (data.modelIdOverride !== undefined) payload.modelIdOverride = data.modelIdOverride;
  if (data.generationConfigOverride !== undefined)
    payload.generationConfigOverride = data.generationConfigOverride;
  if (data.proxyIdOverride !== undefined) payload.proxyIdOverride = data.proxyIdOverride;
  if (data.versionOverride !== undefined) payload.versionOverride = data.versionOverride;
  if (data.connectionOverrides !== undefined)
    payload.connectionOverrides = data.connectionOverrides;
  if (data.dependencyOverrides !== undefined)
    payload.dependencyOverrides = data.dependencyOverrides;
  if (data.actor) {
    payload.userId = data.actor.type === "user" ? data.actor.id : null;
    payload.endUserId = data.actor.type === "end_user" ? data.actor.id : null;
  }

  const [row] = await db
    .update(schedules)
    .set(payload)
    .where(
      scopedWhere(schedules, {
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        extra: [
          eq(schedules.id, expected.id),
          // At the wire stamp's millisecond precision: a `now()` default stores microseconds.
          sql`date_trunc('milliseconds', ${schedules.updatedAt}) = ${expected.updatedAt}::timestamptz`,
        ],
      }),
    )
    .returning();

  // Changed or deleted since the caller read it: every check it ran judged another row.
  if (!row) {
    throw conflict(
      "schedule_modified_concurrently",
      "The schedule changed while this request was being handled. Reload it and retry.",
    );
  }
  const schedule = toSchedule(row);

  if (row.enabled) await upsertScheduleJob(row);
  else await removeScheduleJob(row.id);

  // Same EnrichedSchedule serializer as getSchedule/listSchedules, so the
  // update response matches the GET detail shape (actor/run counters).
  const [enriched] = await enrichSchedules([schedule], scope.orgId, viewer, visibility);
  return enriched ?? { ...schedule, ...UNENRICHED_SCHEDULE_FIELDS };
}

/**
 * Drop the locked input fields from every schedule of one agent in one space when its lock set is
 * written, else each tick fails `locked_input_field` ({@link withoutLockedFields}: the field
 * re-resolves from the editor value). Bumps `updated_at`, so a concurrent schedule write gets a 409.
 */
export async function dropLockedFieldsFromSchedules(
  tx: Tx,
  scope: SpaceScope,
  packageId: string,
  lockedFields: readonly string[],
): Promise<void> {
  if (lockedFields.length === 0) return;

  const rows = await tx
    .select({ id: schedules.id, input: schedules.input })
    .from(schedules)
    .where(
      scopedWhere(schedules, {
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        extra: [eq(schedules.packageId, packageId)],
      }),
    )
    .for("update");

  for (const row of rows) {
    const input = asRecordOrNull(row.input);
    if (!input) continue;
    const stripped = withoutLockedFields(input, lockedFields);
    // Only touch a schedule that actually answers a locked field — every other
    // schedule keeps its row, its `updatedAt` and its queue job untouched.
    if (Object.keys(stripped).length === Object.keys(input).length) continue;
    await tx
      .update(schedules)
      .set({ input: stripped, updatedAt: new Date() })
      .where(eq(schedules.id, row.id));
  }
}

export async function deleteSchedule(scope: SpaceScope, id: string): Promise<boolean> {
  await removeScheduleJob(id);

  const deleted = await db
    .delete(schedules)
    .where(
      scopedWhere(schedules, {
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        extra: [eq(schedules.id, id)],
      }),
    )
    .returning({ id: schedules.id });
  return deleted.length > 0;
}
