// SPDX-License-Identifier: Apache-2.0

import { createQueue } from "../infra/queue/index.ts";
import type { JobQueue, QueueJob } from "../infra/queue/index.ts";
import { eq, asc, inArray, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { schedules, endUsers } from "@appstrate/db/schema";
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
import { getErrorMessage } from "@appstrate/core/errors";
import { asRecordOrNull } from "@appstrate/core/safe-json";
import { getPackage, packageExists } from "./package-catalog.ts";
import { resolveAgentRunVersion } from "./agent-version-resolver.ts";
import type { LoadedPackage } from "../types/index.ts";
import { ApiError, internalError } from "../lib/errors.ts";
import { scopedWhere } from "../lib/db-helpers.ts";
import { validateInput } from "./schema.ts";
import { mergeAndValidateConfigOverride } from "./agent-readiness.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { computeNextRun } from "../lib/cron.ts";
import { actorFromIds, type Actor } from "../lib/actor.ts";
import type { AppScope } from "../lib/scope.ts";
import { setQueueDepthProvider } from "../observability/index.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScheduleJobData {
  scheduleId: string;
  packageId: string;
  /** Actor the scheduled run executes as — at most one set. */
  userId: string | null;
  endUserId: string | null;
  orgId: string;
  applicationId: string;
  input?: Record<string, unknown>;
  // Per-schedule override layer — frozen at schedule create/update and
  // deep-merged with `application_packages.config` every time the
  // schedule fires. Mirrors the per-run override pipeline (POST /run
  // body) so a schedule is "a recurring run with frozen overrides".
  configOverride?: Record<string, unknown>;
  modelIdOverride?: string;
  proxyIdOverride?: string;
  versionOverride?: string;
  /**
   * Frozen per-(integration, authKey) connection picks (#199 mechanism #3).
   * Loaded from `package_schedules.connection_overrides`, propagated into
   * `runs.connection_overrides` at fire time so the snapshot stays in sync
   * with the scheduler's intent. Loses to admin pins.
   */
  connectionOverrides?: Record<string, string>;
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
    applicationId: row.applicationId,
    name: row.name,
    enabled: row.enabled,
    cron_expression: row.cronExpression,
    timezone: row.timezone,
    input: asRecordOrNull(row.input),
    config_override: asRecordOrNull(row.configOverride),
    model_id_override: row.modelIdOverride,
    proxy_id_override: row.proxyIdOverride,
    version_override: row.versionOverride,
    connection_overrides: (row.connectionOverrides as Record<string, string> | null) ?? null,
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

/** Upsert a repeatable job scheduler for a schedule. */
async function upsertScheduleJob(schedule: ScheduleWireDto, orgId: string): Promise<void> {
  const jobData: ScheduleJobData = {
    scheduleId: schedule.id,
    packageId: schedule.packageId,
    userId: schedule.userId,
    endUserId: schedule.endUserId,
    orgId,
    applicationId: schedule.applicationId,
    input: schedule.input ?? undefined,
    configOverride: schedule.config_override ?? undefined,
    modelIdOverride: schedule.model_id_override ?? undefined,
    proxyIdOverride: schedule.proxy_id_override ?? undefined,
    versionOverride: schedule.version_override ?? undefined,
    connectionOverrides: schedule.connection_overrides ?? undefined,
  };

  await (
    await getQueue()
  ).upsertScheduler(
    schedule.id,
    { pattern: schedule.cron_expression, tz: schedule.timezone ?? "UTC" },
    { name: "execute-agent", data: jobData },
  );
}

/** Remove a repeatable job scheduler. */
async function removeScheduleJob(scheduleId: string): Promise<void> {
  await (await getQueue()).removeScheduler(scheduleId);
}

/** Process a scheduled job. */
async function handleScheduleJob(job: QueueJob<ScheduleJobData>): Promise<void> {
  const {
    scheduleId,
    packageId,
    userId,
    endUserId,
    orgId,
    applicationId,
    input,
    configOverride,
    modelIdOverride,
    proxyIdOverride,
    versionOverride,
    connectionOverrides,
  } = job.data;

  await triggerScheduledRun(
    scheduleId,
    packageId,
    actorFromIds(userId, endUserId),
    orgId,
    applicationId,
    input,
    { configOverride, modelIdOverride, proxyIdOverride, versionOverride, connectionOverrides },
  );

  // Update schedule timestamps
  const schedule = await getSchedule(scheduleId, { orgId, applicationId });
  const nextRun = schedule
    ? computeNextRun(schedule.cron_expression, schedule.timezone ?? "UTC")
    : null;

  await db
    .update(schedules)
    .set({
      lastRunAt: new Date(),
      nextRunAt: nextRun ?? null,
      updatedAt: new Date(),
    })
    .where(eq(schedules.id, scheduleId));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Initialize the schedule worker and sync existing schedules from DB. */
export async function initScheduleWorker(): Promise<void> {
  const queue = await getQueue();

  queue.process(
    async (job) => {
      await handleScheduleJob(job);
    },
    { concurrency: 1, limiter: { max: 5, duration: 60_000 } },
  );

  // Feed the observability queue-depth gauge. Stored unconditionally — the
  // gauge only pulls it when telemetry is enabled, otherwise it's never read.
  setQueueDepthProvider(() => queue.count());

  // Sync all enabled schedules from DB to queue
  const rows = await db.select().from(schedules).where(eq(schedules.enabled, true));

  let synced = 0;
  for (const row of rows) {
    if (!(await packageExists(row.packageId))) {
      logger.warn("Schedule references missing package, skipping", {
        scheduleId: row.id,
        packageId: row.packageId,
      });
      continue;
    }
    const schedule = toSchedule(row);
    await upsertScheduleJob(schedule, row.orgId);
    synced++;
  }

  if (synced > 0) {
    logger.info("Schedule worker initialized", { schedulersSynced: synced });
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

async function triggerScheduledRun(
  scheduleId: string,
  packageId: string,
  actor: Actor | null,
  orgId: string,
  applicationId: string,
  input: Record<string, unknown> | undefined,
  overrides: {
    configOverride?: Record<string, unknown>;
    modelIdOverride?: string;
    proxyIdOverride?: string;
    versionOverride?: string;
    connectionOverrides?: Record<string, string>;
  } = {},
) {
  // Populated once the agent loads so every failSchedule() call can
  // denormalize `agent_scope` / `agent_name` onto the failed run row.
  let agentDenorm: { scope: string | null; name: string | null } | null = null;

  /** Create a failed run record + emit onRunStatusChange so modules (webhooks, …) can notify. */
  async function failSchedule(error: string): Promise<void> {
    const runId = `run_${crypto.randomUUID()}`;
    try {
      await createFailedRun(
        { orgId, applicationId },
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
        applicationId,
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
    const draftAgent = await getPackage(packageId, orgId);
    if (!draftAgent) {
      logger.warn("Package not found, skipping schedule", { packageId, scheduleId });
      await failSchedule(`Package '${packageId}' not found`);
      return;
    }
    agentDenorm = extractRunAgentDenorm(draftAgent);

    // Resolve which definition this scheduled run executes (#636). The
    // schedule's `version_override` is a selector (`draft` | `published` |
    // spec); when absent, scheduled runs default to the latest published
    // version when one exists (draft otherwise) — same default as the API
    // run route. Pre-fix, `version_override` only relabeled the run while
    // the draft executed regardless; resolving here makes the pin real.
    let agent: LoadedPackage;
    let overrideVersionLabel: string | undefined;
    try {
      const resolved = await resolveAgentRunVersion(draftAgent, overrides.versionOverride);
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
        return;
      }
      throw err;
    }

    // Shared preflight: resolve config, validate readiness
    let config: Record<string, unknown>;
    let preflightModelId: string | null;
    let preflightProxyId: string | null;
    try {
      const preflight = await resolveRunPreflight({
        agent,
        applicationId,
        orgId,
        actor,
        // Schedule freezes per-integration picks at create time; forward
        // them so readiness honours the same disambiguation the run
        // pipeline will use a few lines down (matches the "single source
        // of truth" intent of overrides).
        scheduleConnectionOverrides: overrides.connectionOverrides ?? null,
      });

      config = preflight.config;
      preflightModelId = preflight.modelId;
      preflightProxyId = preflight.proxyId;
    } catch (err) {
      if (err instanceof ApiError) {
        logger.warn("Agent readiness check failed, skipping schedule", {
          scheduleId,
          packageId,
          code: err.code,
          detail: err.message,
        });
        await failSchedule(err.message);
        return;
      }
      logger.error("Unexpected error during schedule preflight", {
        scheduleId,
        packageId,
        error: getErrorMessage(err),
      });
      await failSchedule(`Preflight error: ${getErrorMessage(err)}`);
      return;
    }

    // Validate input against agent's input schema (schema may have changed since schedule creation)
    const inputSchema = agent.manifest.input?.schema;
    if (inputSchema) {
      const inputValidation = validateInput(input, asJSONSchemaObject(inputSchema));
      if (!inputValidation.valid) {
        logger.warn("Scheduled input validation failed, skipping run", {
          scheduleId,
          packageId,
          errors: inputValidation.errors,
        });
        await failSchedule(
          `Input validation failed: ${inputValidation.errors?.map((e) => e.message).join(", ")}`,
        );
        return;
      }
    }

    const runId = `run_${crypto.randomUUID()}`;

    // Apply per-schedule overrides (deep-merge + re-validate) via the same
    // helper used by `POST /run` so both paths converge to an identical
    // resolved config. Wrapped in try/catch because a frozen schedule
    // override can fall out of schema after a manifest update tightens it
    // — the scheduler must `failSchedule` instead of throwing.
    let mergedConfig: Record<string, unknown>;
    try {
      mergedConfig = mergeAndValidateConfigOverride(agent, config, overrides.configOverride);
    } catch (err) {
      if (err instanceof ApiError) {
        logger.warn("Schedule config override no longer satisfies manifest schema", {
          scheduleId,
          packageId,
          code: err.code,
          detail: err.message,
        });
        await failSchedule(err.message);
        return;
      }
      throw err;
    }

    const finalModelId = overrides.modelIdOverride ?? preflightModelId;
    const finalProxyId = overrides.proxyIdOverride ?? preflightProxyId;

    try {
      await prepareAndExecuteRun({
        runId,
        agent,
        orgId,
        actor,
        input,
        config: mergedConfig,
        configOverride: overrides.configOverride,
        modelId: finalModelId,
        proxyId: finalProxyId,
        overrideVersionLabel,
        scheduleId,
        applicationId,
        scheduleConnectionOverrides: overrides.connectionOverrides ?? null,
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
        return;
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
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

export async function listSchedules(scope: AppScope): Promise<EnrichedSchedule[]> {
  const rows = await db
    .select()
    .from(schedules)
    .where(scopedWhere(schedules, { orgId: scope.orgId, applicationId: scope.applicationId }))
    .orderBy(asc(schedules.createdAt));
  return enrichSchedules(rows.map(toSchedule), scope.orgId);
}

export async function listPackageSchedules(
  scope: AppScope,
  packageId: string,
): Promise<EnrichedSchedule[]> {
  const rows = await db
    .select()
    .from(schedules)
    .where(
      scopedWhere(schedules, {
        orgId: scope.orgId,
        applicationId: scope.applicationId,
        extra: [eq(schedules.packageId, packageId)],
      }),
    )
    .orderBy(asc(schedules.createdAt));
  return enrichSchedules(rows.map(toSchedule), scope.orgId);
}

export async function getSchedule(id: string, scope?: AppScope): Promise<EnrichedSchedule | null> {
  const rows = await db
    .select()
    .from(schedules)
    .where(
      scopedWhere(schedules, {
        orgId: scope?.orgId,
        applicationId: scope?.applicationId,
        extra: [eq(schedules.id, id)],
      }),
    )
    .limit(1);
  if (!rows[0]) return null;
  const schedule = toSchedule(rows[0]);
  const [enriched] = await enrichSchedules([schedule], schedule.orgId);
  return enriched ?? null;
}

/**
 * Enrich schedules with the display name of the actor (member or end-user)
 * each schedule runs as. Batches name lookups per actor kind.
 */
async function enrichSchedules(
  schedules: ScheduleWireDto[],
  _orgId: string,
): Promise<EnrichedSchedule[]> {
  if (schedules.length === 0) return [];

  const userIds = [...new Set(schedules.map((s) => s.userId).filter((id): id is string => !!id))];
  const endUserIds = [
    ...new Set(schedules.map((s) => s.endUserId).filter((id): id is string => !!id)),
  ];

  const [userNameMap, endUserRows] = await Promise.all([
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
    return { ...schedule, actor_name: actorName, actor_type: actorType };
  });
}

export async function createSchedule(
  scope: AppScope,
  packageId: string,
  actor: Actor | null,
  data: {
    name?: string;
    cronExpression: string;
    timezone?: string;
    input?: Record<string, unknown>;
    configOverride?: Record<string, unknown> | null;
    modelIdOverride?: string | null;
    proxyIdOverride?: string | null;
    versionOverride?: string | null;
    connectionOverrides?: Record<string, string> | null;
  },
): Promise<ScheduleWireDto> {
  const id = `sched_${crypto.randomUUID()}`;
  const tz = data.timezone || "UTC";

  // Compute next run (cron parsing only)
  const nextRun = computeNextRun(data.cronExpression, tz);

  const [row] = await db
    .insert(schedules)
    .values({
      id,
      packageId,
      userId: actor?.type === "user" ? actor.id : null,
      endUserId: actor?.type === "end_user" ? actor.id : null,
      orgId: scope.orgId,
      applicationId: scope.applicationId,
      name: data.name ?? null,
      enabled: true,
      cronExpression: data.cronExpression,
      timezone: tz,
      input: data.input ?? null,
      configOverride: data.configOverride ?? null,
      modelIdOverride: data.modelIdOverride ?? null,
      proxyIdOverride: data.proxyIdOverride ?? null,
      versionOverride: data.versionOverride ?? null,
      connectionOverrides: data.connectionOverrides ?? null,
      nextRunAt: nextRun ?? null,
    })
    .returning();

  if (!row) {
    throw internalError();
  }
  const schedule = toSchedule(row);

  await upsertScheduleJob(schedule, scope.orgId);

  return schedule;
}

export async function updateSchedule(
  scope: AppScope,
  id: string,
  data: {
    name?: string;
    cronExpression?: string;
    timezone?: string;
    input?: Record<string, unknown>;
    enabled?: boolean;
    configOverride?: Record<string, unknown> | null;
    modelIdOverride?: string | null;
    proxyIdOverride?: string | null;
    versionOverride?: string | null;
    connectionOverrides?: Record<string, string> | null;
  },
): Promise<ScheduleWireDto | null> {
  const existing = await getSchedule(id, scope);
  if (!existing) return null;

  const cronExpr = data.cronExpression ?? existing.cron_expression;
  const tz = data.timezone ?? existing.timezone ?? "UTC";
  const enabled = data.enabled ?? existing.enabled;

  // Compute next run (cron parsing only)
  const nextRun = enabled ? computeNextRun(cronExpr, tz ?? "UTC") : null;

  const payload: Record<string, unknown> = {
    cronExpression: cronExpr,
    timezone: tz,
    enabled,
    nextRunAt: nextRun ?? null,
    updatedAt: new Date(),
  };
  if (data.name !== undefined) payload.name = data.name;
  if (data.input !== undefined) payload.input = data.input;
  // Explicit `null` clears the override; `undefined` leaves it untouched.
  if (data.configOverride !== undefined) payload.configOverride = data.configOverride;
  if (data.modelIdOverride !== undefined) payload.modelIdOverride = data.modelIdOverride;
  if (data.proxyIdOverride !== undefined) payload.proxyIdOverride = data.proxyIdOverride;
  if (data.versionOverride !== undefined) payload.versionOverride = data.versionOverride;
  if (data.connectionOverrides !== undefined)
    payload.connectionOverrides = data.connectionOverrides;

  const [row] = await db
    .update(schedules)
    .set(payload)
    .where(
      scopedWhere(schedules, {
        orgId: scope.orgId,
        applicationId: scope.applicationId,
        extra: [eq(schedules.id, id)],
      }),
    )
    .returning();

  if (!row) {
    throw internalError();
  }
  const schedule = toSchedule(row);

  if (schedule.enabled) {
    await upsertScheduleJob(schedule, scope.orgId);
  } else {
    await removeScheduleJob(id);
  }

  return schedule;
}

export async function deleteSchedule(scope: AppScope, id: string): Promise<boolean> {
  await removeScheduleJob(id);

  const deleted = await db
    .delete(schedules)
    .where(
      scopedWhere(schedules, {
        orgId: scope.orgId,
        applicationId: scope.applicationId,
        extra: [eq(schedules.id, id)],
      }),
    )
    .returning({ id: schedules.id });
  return deleted.length > 0;
}
