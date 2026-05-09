// SPDX-License-Identifier: Apache-2.0

import { createQueue } from "../infra/queue/index.ts";
import type { JobQueue, QueueJob } from "../infra/queue/index.ts";
import { eq, asc, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { schedules, connectionProfiles as connectionProfilesTable } from "@appstrate/db/schema";
import { batchLoadUserNames } from "../lib/user-helpers.ts";
import { logger } from "../lib/logger.ts";
import type { Schedule, EnrichedSchedule, ScheduleReadiness } from "@appstrate/shared-types";
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
import type { ConnectionProfile } from "@appstrate/db/schema";
import {
  getProfileByIdUnsafe,
  resolveProviderProfiles,
  resolveScheduleProfileArgs,
  getAgentAppProfile,
} from "./connection-profiles.ts";
import { resolveProviderStatuses } from "./connection-manager/status.ts";
import type { LoadedPackage, ProviderProfileMap } from "../types/index.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { ApiError, internalError } from "../lib/errors.ts";
import { scopedWhere } from "../lib/db-helpers.ts";
import { validateInput } from "./schema.ts";
import { mergeAndValidateConfigOverride } from "./agent-readiness.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { computeNextRun } from "../lib/cron.ts";
import { actorFromIds, type Actor } from "../lib/actor.ts";
import type { AppScope } from "../lib/scope.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScheduleJobData {
  scheduleId: string;
  packageId: string;
  connectionProfileId: string;
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a Drizzle schedule row to the Schedule type. */
function toSchedule(row: typeof schedules.$inferSelect): Schedule {
  return {
    ...row,
    input: asRecordOrNull(row.input),
    configOverride: asRecordOrNull(row.configOverride),
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
async function upsertScheduleJob(schedule: Schedule, orgId: string): Promise<void> {
  const jobData: ScheduleJobData = {
    scheduleId: schedule.id,
    packageId: schedule.packageId,
    connectionProfileId: schedule.connectionProfileId,
    orgId,
    applicationId: schedule.applicationId,
    input: schedule.input ?? undefined,
    configOverride: schedule.configOverride ?? undefined,
    modelIdOverride: schedule.modelIdOverride ?? undefined,
    proxyIdOverride: schedule.proxyIdOverride ?? undefined,
    versionOverride: schedule.versionOverride ?? undefined,
  };

  await (
    await getQueue()
  ).upsertScheduler(
    schedule.id,
    { pattern: schedule.cronExpression, tz: schedule.timezone ?? "UTC" },
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
    connectionProfileId,
    orgId,
    applicationId,
    input,
    configOverride,
    modelIdOverride,
    proxyIdOverride,
    versionOverride,
  } = job.data;

  await triggerScheduledRun(
    scheduleId,
    packageId,
    connectionProfileId,
    orgId,
    applicationId,
    input,
    { configOverride, modelIdOverride, proxyIdOverride, versionOverride },
  );

  // Update schedule timestamps
  const schedule = await getSchedule(scheduleId, { orgId, applicationId });
  const nextRun = schedule
    ? computeNextRun(schedule.cronExpression, schedule.timezone ?? "UTC")
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
  connectionProfileId: string,
  orgId: string,
  applicationId: string,
  input: Record<string, unknown> | undefined,
  overrides: {
    configOverride?: Record<string, unknown>;
    modelIdOverride?: string;
    proxyIdOverride?: string;
    versionOverride?: string;
  } = {},
) {
  // Populated once the agent loads so every failSchedule() call can
  // denormalize `agent_scope` / `agent_name` onto the failed run row.
  let agentDenorm: { scope: string | null; name: string | null } | null = null;

  /** Create a failed run record + emit onRunStatusChange so modules (webhooks, …) can notify. */
  async function failSchedule(error: string, actor: Actor | null = null): Promise<void> {
    const runId = `run_${crypto.randomUUID()}`;
    try {
      await createFailedRun(
        { orgId, applicationId },
        runId,
        packageId,
        actor,
        error,
        scheduleId,
        connectionProfileId,
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
    const agent = await getPackage(packageId, orgId);
    if (!agent) {
      logger.warn("Package not found, skipping schedule", { packageId, scheduleId });
      await failSchedule(`Package '${packageId}' not found`);
      return;
    }
    agentDenorm = extractRunAgentDenorm(agent);

    // Resolve actor from connection profile (null for app profiles)
    const profile = await getProfileByIdUnsafe(connectionProfileId);
    if (!profile) {
      logger.warn("Connection profile not found, skipping schedule", {
        scheduleId,
        connectionProfileId,
      });
      await failSchedule("Connection profile not found");
      return;
    }

    const actor: Actor | null = actorFromIds(profile.userId, profile.endUserId);

    // Load the agent's admin-configured app profile (validates it still exists)
    const agentAppProfile = await getAgentAppProfile({ orgId, applicationId }, packageId);
    const { defaultUserProfileId, appProfileId } = resolveScheduleProfileArgs(
      profile,
      connectionProfileId,
      agentAppProfile?.id ?? null,
    );

    // Shared preflight: resolve providers, config, validate readiness
    let providerProfiles: ProviderProfileMap;
    let config: Record<string, unknown>;
    let preflightModelId: string | null;
    let preflightProxyId: string | null;
    try {
      const preflight = await resolveRunPreflight({
        agent,
        applicationId,
        orgId,
        defaultUserProfileId,
        appProfileId,
      });

      providerProfiles = preflight.providerProfiles;
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
        await failSchedule(err.message, actor);
        return;
      }
      logger.error("Unexpected error during schedule preflight", {
        scheduleId,
        packageId,
        error: getErrorMessage(err),
      });
      await failSchedule(`Preflight error: ${getErrorMessage(err)}`, actor);
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
          actor,
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
        await failSchedule(err.message, actor);
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
        providerProfiles,
        orgId,
        actor,
        input,
        config: mergedConfig,
        configOverride: overrides.configOverride,
        modelId: finalModelId,
        proxyId: finalProxyId,
        overrideVersionLabel: overrides.versionOverride,
        scheduleId,
        connectionProfileId,
        applicationId,
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
        await failSchedule(err.message, actor);
        return;
      }
      throw err;
    }

    logger.info("Triggering scheduled run", {
      runId,
      packageId,
      scheduleId,
      connectionProfileId,
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

/** Compute readiness status for a single schedule based on its profile and agent. */
async function computeScheduleReadiness(
  schedule: Schedule,
  profile: ConnectionProfile | null,
  agent: LoadedPackage | null,
  orgId: string,
): Promise<ScheduleReadiness> {
  if (!agent) {
    return { status: "not_ready", totalProviders: 0, connectedProviders: 0, missingProviders: [] };
  }

  const providers = resolveManifestProviders(agent.manifest);

  if (!profile) {
    return {
      status: "not_ready",
      totalProviders: providers.length,
      connectedProviders: 0,
      missingProviders: providers.map((p) => p.id),
    };
  }

  if (providers.length === 0) {
    return { status: "ready", totalProviders: 0, connectedProviders: 0, missingProviders: [] };
  }

  const { defaultUserProfileId, appProfileId } = resolveScheduleProfileArgs(
    profile,
    schedule.connectionProfileId,
  );
  const providerProfiles = await resolveProviderProfiles(
    providers,
    defaultUserProfileId,
    undefined,
    appProfileId,
    schedule.applicationId,
  );

  // Reuse the shared provider status resolution (batch-fetches connections)
  const statuses = await resolveProviderStatuses(
    { orgId, applicationId: schedule.applicationId },
    providers,
    providerProfiles,
  );

  const missing = statuses.filter((s) => s.status !== "connected").map((s) => s.id);
  const connected = statuses.filter((s) => s.status === "connected").length;

  return {
    status: missing.length === 0 ? "ready" : connected > 0 ? "degraded" : "not_ready",
    totalProviders: providers.length,
    connectedProviders: connected,
    missingProviders: missing,
  };
}

/**
 * Enrich schedules with profile info and readiness status.
 * Batches lookups by unique profileId and packageId for efficiency.
 */
async function enrichSchedules(schedules: Schedule[], orgId: string): Promise<EnrichedSchedule[]> {
  if (schedules.length === 0) return [];

  // Batch load unique profiles in one query
  const profileIds = [...new Set(schedules.map((s) => s.connectionProfileId))];
  const profileRows = await db
    .select()
    .from(connectionProfilesTable)
    .where(inArray(connectionProfilesTable.id, profileIds));
  const profileMap = new Map<string, ConnectionProfile | null>(
    profileIds.map((id) => [id, profileRows.find((r) => r.id === id) ?? null]),
  );

  // Batch load user names for user-owned profiles
  const userIds = [...new Set(profileRows.filter((p) => p.userId).map((p) => p.userId!))];
  const userNameMap = await batchLoadUserNames(userIds);

  // Batch load unique agents
  const packageIds = [...new Set(schedules.map((s) => s.packageId))];
  const agents = await Promise.all(packageIds.map((id) => getPackage(id, orgId)));
  const agentMap = new Map(packageIds.map((id, i) => [id, agents[i] ?? null]));

  return Promise.all(
    schedules.map(async (schedule) => {
      const profile = profileMap.get(schedule.connectionProfileId);
      const agent = agentMap.get(schedule.packageId);

      let profileName: string | null = null;
      let profileType: "user" | "app" | null = null;
      let profileOwnerName: string | null = null;
      if (profile) {
        profileName = profile.name;
        profileType = profile.applicationId ? "app" : "user";
        if (profile.userId) {
          profileOwnerName = userNameMap.get(profile.userId) ?? null;
        }
      }

      const readiness = await computeScheduleReadiness(
        schedule,
        profile ?? null,
        agent ?? null,
        orgId,
      );
      return { ...schedule, profileName, profileType, profileOwnerName, readiness };
    }),
  );
}

export async function createSchedule(
  scope: AppScope,
  packageId: string,
  connectionProfileId: string,
  data: {
    name?: string;
    cronExpression: string;
    timezone?: string;
    input?: Record<string, unknown>;
    configOverride?: Record<string, unknown> | null;
    modelIdOverride?: string | null;
    proxyIdOverride?: string | null;
    versionOverride?: string | null;
  },
): Promise<Schedule> {
  const id = `sched_${crypto.randomUUID()}`;
  const tz = data.timezone || "UTC";

  // Compute next run (cron parsing only)
  const nextRun = computeNextRun(data.cronExpression, tz);

  const [row] = await db
    .insert(schedules)
    .values({
      id,
      packageId,
      connectionProfileId,
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
    connectionProfileId?: string;
    name?: string;
    cronExpression?: string;
    timezone?: string;
    input?: Record<string, unknown>;
    enabled?: boolean;
    configOverride?: Record<string, unknown> | null;
    modelIdOverride?: string | null;
    proxyIdOverride?: string | null;
    versionOverride?: string | null;
  },
): Promise<Schedule | null> {
  const existing = await getSchedule(id, scope);
  if (!existing) return null;

  const cronExpr = data.cronExpression ?? existing.cronExpression;
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
  if (data.connectionProfileId !== undefined)
    payload.connectionProfileId = data.connectionProfileId;
  if (data.name !== undefined) payload.name = data.name;
  if (data.input !== undefined) payload.input = data.input;
  // Explicit `null` clears the override; `undefined` leaves it untouched.
  if (data.configOverride !== undefined) payload.configOverride = data.configOverride;
  if (data.modelIdOverride !== undefined) payload.modelIdOverride = data.modelIdOverride;
  if (data.proxyIdOverride !== undefined) payload.proxyIdOverride = data.proxyIdOverride;
  if (data.versionOverride !== undefined) payload.versionOverride = data.versionOverride;

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
