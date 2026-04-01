import { Queue, Worker } from "bullmq";
import type { Job, ConnectionOptions } from "bullmq";
import { eq, and, asc, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  packageSchedules,
  connectionProfiles as connectionProfilesTable,
  userProviderConnections,
} from "@appstrate/db/schema";
import { batchLoadUserNames } from "../lib/user-helpers.ts";
import { logger } from "../lib/logger.ts";
import type { Schedule, EnrichedSchedule, ScheduleReadiness } from "@appstrate/shared-types";
import { createExecution, createFailedExecution } from "./state/index.ts";
import { executeFlowInBackground } from "../routes/executions.ts";
import { dispatchWebhookEvents } from "./webhooks.ts";
import { buildExecutionContext, ModelNotConfiguredError } from "./env-builder.ts";
import { asRecordOrNull } from "../lib/safe-json.ts";
import type { PromptContext } from "./adapters/types.ts";
import { getPackage, packageExists } from "./flow-service.ts";
import { getPackageConfig } from "./state/index.ts";
import { validateFlowReadiness } from "./flow-readiness.ts";
import type { ConnectionProfile } from "@appstrate/db/schema";
import {
  getProfileByIdUnsafe,
  resolveProviderProfiles,
  resolveScheduleProfileArgs,
  getFlowOrgProfile,
} from "./connection-profiles.ts";
import type { LoadedPackage, ProviderProfileMap } from "../types/index.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
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
  /** Create a failed execution record + dispatch webhook so the user is notified. */
  async function failSchedule(error: string, actor: Actor | null = null): Promise<void> {
    const executionId = `exec_${crypto.randomUUID()}`;
    try {
      await createFailedExecution(
        executionId,
        packageId,
        actor,
        orgId,
        error,
        scheduleId,
        connectionProfileId,
      );
      dispatchWebhookEvents(orgId, "execution.failed", {
        id: executionId,
        packageId,
        status: "failed",
        error,
      }).catch(() => {});
    } catch (err) {
      logger.error("Failed to create failed schedule execution record", {
        scheduleId,
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    const flow = await getPackage(packageId, orgId);
    if (!flow) {
      logger.warn("Package not found, skipping schedule", { packageId, scheduleId });
      await failSchedule(`Package '${packageId}' not found`);
      return;
    }

    // Resolve actor from connection profile (null for org profiles)
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

    // Load the flow's admin-configured org profile (validates it still exists)
    const flowOrgProfile = await getFlowOrgProfile(orgId, packageId);
    const { defaultUserProfileId, orgProfileId } = resolveScheduleProfileArgs(
      profile,
      connectionProfileId,
      flowOrgProfile?.id ?? null,
    );

    // Resolve provider profiles, config, and validate readiness (inlined preflight).
    // Schedules don't support per-provider overrides.
    let providerProfiles: ProviderProfileMap;
    let config: Record<string, unknown>;
    let preflightModelId: string | null;
    let preflightProxyId: string | null;
    try {
      const manifestProviders = resolveManifestProviders(flow.manifest);

      const [resolvedProfiles, packageConfig] = await Promise.all([
        resolveProviderProfiles(
          manifestProviders,
          defaultUserProfileId,
          undefined,
          orgProfileId,
          orgId,
        ),
        getPackageConfig(orgId, packageId),
      ]);

      await validateFlowReadiness({
        flow,
        providerProfiles: resolvedProfiles,
        orgId,
        config: packageConfig.config,
      });

      providerProfiles = resolvedProfiles;
      config = packageConfig.config;
      preflightModelId = packageConfig.modelId;
      preflightProxyId = packageConfig.proxyId;
    } catch (err) {
      if (err instanceof ApiError) {
        logger.warn("Flow readiness check failed, skipping schedule", {
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
        await failSchedule(
          `Input validation failed: ${inputValidation.errors?.map((e) => e.message).join(", ")}`,
          actor,
        );
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
        await failSchedule("No model configured", actor);
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
          await failSchedule(err.message, actor);
          return;
        }
        throw err;
      }
    }

    // Extract just the profileId map (strip source field)
    const profileIdMap = Object.fromEntries(
      Object.entries(providerProfiles).map(([k, v]) => [k, v.profileId]),
    );

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
      undefined,
      profileIdMap,
    );

    logger.info("Triggering scheduled execution", {
      executionId,
      packageId,
      scheduleId,
      connectionProfileId,
      orgId,
    });

    // Fire-and-forget (catch to prevent unhandled rejection)
    executeFlowInBackground(executionId, orgId, flow, promptContext, flowPackage).catch((err) => {
      logger.error("Unhandled error in scheduled execution", {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
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

  const { defaultUserProfileId, orgProfileId } = resolveScheduleProfileArgs(
    profile,
    schedule.connectionProfileId,
  );
  const providerProfiles = await resolveProviderProfiles(
    providers,
    defaultUserProfileId,
    undefined,
    orgProfileId,
    orgId,
  );

  // Batch-fetch all connections for resolved profile IDs in one query
  const resolvedProfileIds = [
    ...new Set(
      providers.map((p) => providerProfiles[p.id]?.profileId).filter((id): id is string => !!id),
    ),
  ];

  const connectionMap = new Map<string, boolean>();
  if (resolvedProfileIds.length > 0) {
    const connRows = await db
      .select({
        profileId: userProviderConnections.profileId,
        providerId: userProviderConnections.providerId,
      })
      .from(userProviderConnections)
      .where(
        and(
          inArray(userProviderConnections.profileId, resolvedProfileIds),
          eq(userProviderConnections.orgId, orgId),
        ),
      );
    for (const row of connRows) {
      connectionMap.set(`${row.profileId}:${row.providerId}`, true);
    }
  }

  const results = providers.map((p) => {
    const sourceProfileId = providerProfiles[p.id]?.profileId;
    if (!sourceProfileId) return { id: p.id, connected: false };
    return { id: p.id, connected: connectionMap.has(`${sourceProfileId}:${p.id}`) };
  });

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
    throw internalError();
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

  const [row] = await db
    .update(packageSchedules)
    .set(payload)
    .where(eq(packageSchedules.id, id))
    .returning();

  if (!row) {
    throw internalError();
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
