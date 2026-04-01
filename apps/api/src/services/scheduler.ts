import { Queue, Worker } from "bullmq";
import type { Job, ConnectionOptions } from "bullmq";
import { eq, and, asc } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packageSchedules } from "@appstrate/db/schema";
import { batchLoadUserNames } from "../lib/user-helpers.ts";
import { logger } from "../lib/logger.ts";
import type { Schedule, EnrichedSchedule, ScheduleReadiness } from "@appstrate/shared-types";
import { createExecution } from "./state/index.ts";
import { executeFlowInBackground } from "../routes/executions.ts";
import {
  buildExecutionContext,
  resolvePreflightContext,
  ModelNotConfiguredError,
} from "./env-builder.ts";
import { asRecordOrNull } from "../lib/safe-json.ts";
import type { PromptContext } from "./adapters/types.ts";
import { getPackage, packageExists } from "./flow-service.ts";
import type { ConnectionProfile } from "@appstrate/db/schema";
import {
  getProfileByIdUnsafe,
  resolveProviderProfiles,
  getFlowOrgProfile,
} from "./connection-profiles.ts";
import type { LoadedPackage, ProviderProfileMap } from "../types/index.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { getConnection } from "@appstrate/connect";
import { ApiError, internalError } from "../lib/errors.ts";
import { validateInput } from "./schema.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { getRedisConnection } from "../lib/redis.ts";
import { computeNextRun } from "../lib/cron.ts";
import { getRunningExecutionCountForOrg } from "./state/index.ts";
import { getCloudModule } from "../lib/cloud-loader.ts";
import { actorFromIds, type Actor } from "../lib/actor.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScheduleJobData {
  scheduleId: string;
  packageId: string;
  connectionProfileId: string;
  orgId: string;
  input?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a Drizzle schedule row to the Schedule type. */
function toSchedule(row: typeof packageSchedules.$inferSelect): Schedule {
  return {
    ...row,
    input: asRecordOrNull(row.input),
  };
}

// ---------------------------------------------------------------------------
// BullMQ queue & worker
// ---------------------------------------------------------------------------

const QUEUE_NAME = "schedules";

let scheduleQueue: Queue | null = null;
let scheduleWorker: Worker | null = null;

function getQueue(): Queue {
  if (!scheduleQueue) {
    scheduleQueue = new Queue(QUEUE_NAME, {
      connection: getRedisConnection() as unknown as ConnectionOptions,
    });
  }
  return scheduleQueue;
}

/** Upsert a BullMQ repeatable job scheduler for a schedule. */
async function upsertScheduleJob(schedule: Schedule, orgId: string): Promise<void> {
  const queue = getQueue();

  const jobData: ScheduleJobData = {
    scheduleId: schedule.id,
    packageId: schedule.packageId,
    connectionProfileId: schedule.connectionProfileId,
    orgId,
    input: asRecordOrNull(schedule.input) ?? undefined,
  };

  await queue.upsertJobScheduler(
    schedule.id,
    {
      pattern: schedule.cronExpression,
      tz: schedule.timezone ?? "UTC",
    },
    {
      name: "execute-flow",
      data: jobData,
    },
  );
}

/** Remove a BullMQ repeatable job scheduler. */
async function removeScheduleJob(scheduleId: string): Promise<void> {
  const queue = getQueue();
  await queue.removeJobScheduler(scheduleId);
}

/** Process a scheduled job via BullMQ worker. */
async function handleScheduleJob(job: Job<ScheduleJobData>): Promise<void> {
  const { scheduleId, packageId, connectionProfileId, orgId, input } = job.data;

  await triggerScheduledExecution(scheduleId, packageId, connectionProfileId, orgId, input);

  // Update schedule timestamps
  const schedule = await getSchedule(scheduleId);
  const nextRun = schedule
    ? computeNextRun(schedule.cronExpression, schedule.timezone ?? "UTC")
    : null;

  await db
    .update(packageSchedules)
    .set({
      lastRunAt: new Date(),
      nextRunAt: nextRun ?? null,
      updatedAt: new Date(),
    })
    .where(eq(packageSchedules.id, scheduleId));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Initialize the BullMQ worker and sync existing schedules from DB. */
export async function initScheduleWorker(): Promise<void> {
  scheduleWorker = new Worker<ScheduleJobData>(
    QUEUE_NAME,
    async (job) => {
      await handleScheduleJob(job);
    },
    {
      connection: getRedisConnection() as unknown as ConnectionOptions,
      // concurrency: 1 ensures this worker processes one job at a time.
      // Combined with the group limiter below, this caps throughput per instance.
      concurrency: 1,
      limiter: {
        // NOTE: BullMQ limiter is per-worker, not global across instances.
        // With N instances running N workers, the effective global rate is N × max.
        // This is acceptable: each instance handles its own share of the queue,
        // and BullMQ's distributed locking prevents duplicate processing.
        max: 5,
        duration: 60_000,
      },
    },
  );

  scheduleWorker.on("failed", (job, err) => {
    logger.error("Schedule job failed", {
      jobId: job?.id,
      scheduleId: job?.data?.scheduleId,
      error: err.message,
    });
  });

  // Sync all enabled schedules from DB to BullMQ
  const rows = await db.select().from(packageSchedules).where(eq(packageSchedules.enabled, true));

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
    logger.info("BullMQ scheduler initialized", { schedulersSynced: synced });
  }
}

/** Shutdown BullMQ worker and queue. */
export async function shutdownScheduleWorker(): Promise<void> {
  await scheduleWorker?.close();
  await scheduleQueue?.close();
  scheduleWorker = null;
  scheduleQueue = null;
  logger.info("Schedule worker stopped");
}

// ---------------------------------------------------------------------------
// Execution trigger
// ---------------------------------------------------------------------------

async function triggerScheduledExecution(
  scheduleId: string,
  packageId: string,
  connectionProfileId: string,
  orgId: string,
  input: Record<string, unknown> | undefined,
) {
  try {
    const flow = await getPackage(packageId, orgId);
    if (!flow) {
      logger.warn("Package not found, skipping schedule", { packageId, scheduleId });
      return;
    }

    // Resolve actor from connection profile (null for org profiles)
    const profile = await getProfileByIdUnsafe(connectionProfileId);
    if (!profile) {
      logger.warn("Connection profile not found, skipping schedule", {
        scheduleId,
        connectionProfileId,
      });
      return;
    }

    const actor: Actor | null = actorFromIds(profile.userId, profile.endUserId);

    // Load the flow's admin-configured org profile (validates it still exists)
    const flowOrgProfile = await getFlowOrgProfile(orgId, packageId);
    const flowOrgProfileId = flowOrgProfile?.id ?? null;

    // Resolve provider profiles, config, and validate readiness.
    // Schedules don't support per-provider overrides — the schedule's connectionProfileId
    // is used as the default for all unbound providers.
    let providerProfiles: ProviderProfileMap;
    let config: Record<string, unknown>;
    let preflightModelId: string | null;
    let preflightProxyId: string | null;
    try {
      ({
        providerProfiles,
        config,
        modelId: preflightModelId,
        proxyId: preflightProxyId,
      } = await resolvePreflightContext({
        flow,
        packageId,
        orgId,
        defaultUserProfileId: connectionProfileId,
        orgProfileId: flowOrgProfileId,
      }));
    } catch (err) {
      if (err instanceof ApiError) {
        logger.warn("Flow readiness check failed, skipping schedule", {
          scheduleId,
          packageId,
          code: err.code,
          detail: err.message,
        });
        return;
      }
      throw err;
    }

    // Validate input against flow's input schema (schema may have changed since schedule creation)
    const inputSchema = flow.manifest.input?.schema;
    if (inputSchema) {
      const inputValidation = validateInput(input, asJSONSchemaObject(inputSchema));
      if (!inputValidation.valid) {
        logger.warn("Scheduled input validation failed, skipping execution", {
          scheduleId,
          packageId,
          errors: inputValidation.errors,
        });
        return;
      }
    }

    const executionId = `exec_${crypto.randomUUID()}`;

    // Build execution context (tokens, config, state, providers, package, version)
    let promptContext: PromptContext;
    let flowPackage: Buffer | null;
    let packageVersionId: number | null;
    let proxyLabel: string | null;
    let modelLabel: string | null;
    try {
      ({ promptContext, flowPackage, packageVersionId, proxyLabel, modelLabel } =
        await buildExecutionContext({
          executionId,
          flow,
          providerProfiles,
          orgId,
          actor,
          input,
          config,
          modelId: preflightModelId,
          proxyId: preflightProxyId,
        }));
    } catch (err) {
      if (err instanceof ModelNotConfiguredError) {
        logger.warn("No model configured, skipping scheduled execution", {
          scheduleId,
          packageId,
          orgId,
        });
        return;
      }
      throw err;
    }

    // Pre-execution quota check (Cloud only — skip silently if quota exceeded)
    const cloud = getCloudModule();
    if (cloud) {
      try {
        const runningCount = await getRunningExecutionCountForOrg(orgId);
        await cloud.cloudHooks.checkQuota(orgId, runningCount);
      } catch (err) {
        if (err instanceof cloud.QuotaExceededError) {
          logger.warn("Quota exceeded, skipping scheduled execution", {
            scheduleId,
            packageId,
            orgId,
            reason: err.message,
          });
          return;
        }
        throw err;
      }
    }

    // Create execution record with schedule_id and version
    await createExecution(
      executionId,
      packageId,
      actor,
      orgId,
      input ?? null,
      scheduleId,
      packageVersionId ?? undefined,
      connectionProfileId,
      proxyLabel ?? undefined,
      modelLabel ?? undefined,
    );

    logger.info("Triggering scheduled execution", {
      executionId,
      packageId,
      scheduleId,
      connectionProfileId,
      orgId,
    });

    // Fire-and-forget (catch to prevent unhandled rejection)
    executeFlowInBackground(executionId, actor, orgId, flow, promptContext, flowPackage).catch(
      (err) => {
        logger.error("Unhandled error in scheduled execution", {
          executionId,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
  } catch (err) {
    logger.error("Failed to trigger schedule", {
      scheduleId,
      packageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

export async function listSchedules(orgId: string): Promise<EnrichedSchedule[]> {
  const rows = await db
    .select()
    .from(packageSchedules)
    .where(eq(packageSchedules.orgId, orgId))
    .orderBy(asc(packageSchedules.createdAt));
  return enrichSchedules(rows.map(toSchedule), orgId);
}

export async function listPackageSchedules(
  packageId: string,
  orgId: string,
): Promise<EnrichedSchedule[]> {
  const rows = await db
    .select()
    .from(packageSchedules)
    .where(and(eq(packageSchedules.packageId, packageId), eq(packageSchedules.orgId, orgId)))
    .orderBy(asc(packageSchedules.createdAt));
  return enrichSchedules(rows.map(toSchedule), orgId);
}

export async function getSchedule(id: string): Promise<EnrichedSchedule | null> {
  const rows = await db.select().from(packageSchedules).where(eq(packageSchedules.id, id)).limit(1);
  if (!rows[0]) return null;
  const schedule = toSchedule(rows[0]);
  const [enriched] = await enrichSchedules([schedule], schedule.orgId);
  return enriched ?? null;
}

/** Compute readiness status for a single schedule based on its profile and flow. */
async function computeScheduleReadiness(
  schedule: Schedule,
  profile: ConnectionProfile | null,
  flow: LoadedPackage | null,
  orgId: string,
): Promise<ScheduleReadiness> {
  if (!flow) {
    return { status: "not_ready", totalProviders: 0, connectedProviders: 0, missingProviders: [] };
  }

  const providers = resolveManifestProviders(flow.manifest);

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

  // Schedule profile: if org profile, all providers must be bound (no user fallback).
  // If user profile, all providers use it directly.
  const isOrgProfile = !!profile.orgId;
  const providerProfiles = await resolveProviderProfiles(
    providers,
    isOrgProfile ? "" : schedule.connectionProfileId, // org profiles have no user fallback
    undefined, // no per-provider overrides for schedules
    isOrgProfile ? schedule.connectionProfileId : null,
  );

  const results = await Promise.all(
    providers.map(async (p) => {
      const sourceProfileId = providerProfiles[p.id]?.profileId;
      if (!sourceProfileId) return { id: p.id, connected: false };
      const conn = await getConnection(db, sourceProfileId, p.id, orgId);
      return { id: p.id, connected: !!conn };
    }),
  );

  const missing = results.filter((r) => !r.connected).map((r) => r.id);
  const connected = results.filter((r) => r.connected).length;

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

  // Batch load unique profiles
  const profileIds = [...new Set(schedules.map((s) => s.connectionProfileId))];
  const profiles = await Promise.all(profileIds.map((id) => getProfileByIdUnsafe(id)));
  const profileMap = new Map(profileIds.map((id, i) => [id, profiles[i] ?? null]));

  // Batch load user names for user-owned profiles
  const userIds = [...new Set(profiles.filter((p) => p?.userId).map((p) => p!.userId!))];
  const userNameMap = await batchLoadUserNames(userIds);

  // Batch load unique flows
  const packageIds = [...new Set(schedules.map((s) => s.packageId))];
  const flows = await Promise.all(packageIds.map((id) => getPackage(id, orgId)));
  const flowMap = new Map(packageIds.map((id, i) => [id, flows[i] ?? null]));

  return Promise.all(
    schedules.map(async (schedule) => {
      const profile = profileMap.get(schedule.connectionProfileId);
      const flow = flowMap.get(schedule.packageId);

      let profileName: string | null = null;
      let profileType: "user" | "org" | null = null;
      let profileOwnerName: string | null = null;
      if (profile) {
        profileName = profile.name;
        profileType = profile.orgId ? "org" : "user";
        if (profile.userId) {
          profileOwnerName = userNameMap.get(profile.userId) ?? null;
        }
      }

      const readiness = await computeScheduleReadiness(
        schedule,
        profile ?? null,
        flow ?? null,
        orgId,
      );
      return { ...schedule, profileName, profileType, profileOwnerName, readiness };
    }),
  );
}

export async function createSchedule(
  packageId: string,
  connectionProfileId: string,
  orgId: string,
  data: {
    name?: string;
    cronExpression: string;
    timezone?: string;
    input?: Record<string, unknown>;
  },
): Promise<Schedule> {
  const id = `sched_${crypto.randomUUID()}`;
  const tz = data.timezone || "UTC";

  // Compute next run (cron parsing only)
  const nextRun = computeNextRun(data.cronExpression, tz);

  const [row] = await db
    .insert(packageSchedules)
    .values({
      id,
      packageId,
      connectionProfileId,
      orgId,
      name: data.name ?? null,
      enabled: true,
      cronExpression: data.cronExpression,
      timezone: tz,
      input: data.input ?? null,
      nextRunAt: nextRun ?? null,
    })
    .returning();

  if (!row) {
    throw internalError("Failed to create schedule: no row returned");
  }
  const schedule = toSchedule(row);

  await upsertScheduleJob(schedule, orgId);

  return schedule;
}

export async function updateSchedule(
  id: string,
  data: {
    connectionProfileId?: string;
    name?: string;
    cronExpression?: string;
    timezone?: string;
    input?: Record<string, unknown>;
    enabled?: boolean;
  },
): Promise<Schedule | null> {
  const existing = await getSchedule(id);
  if (!existing) return null;

  const cronExpr = data.cronExpression ?? existing.cronExpression;
  const tz = data.timezone ?? existing.timezone ?? "UTC";
  const enabled = data.enabled ?? existing.enabled;

  // Compute next run (cron parsing only)
  const nextRun = enabled ? computeNextRun(cronExpr, tz) : null;

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

  const [row] = await db
    .update(packageSchedules)
    .set(payload)
    .where(eq(packageSchedules.id, id))
    .returning();

  if (!row) {
    throw internalError(`Failed to update schedule ${id}: no row returned`);
  }
  const schedule = toSchedule(row);

  if (schedule.enabled) {
    await upsertScheduleJob(schedule, existing.orgId);
  } else {
    await removeScheduleJob(id);
  }

  return schedule;
}

export async function deleteSchedule(id: string): Promise<boolean> {
  await removeScheduleJob(id);

  const deleted = await db
    .delete(packageSchedules)
    .where(eq(packageSchedules.id, id))
    .returning({ id: packageSchedules.id });
  return deleted.length > 0;
}
