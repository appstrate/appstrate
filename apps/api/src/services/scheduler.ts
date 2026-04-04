// SPDX-License-Identifier: Apache-2.0

import { createQueue } from "../infra/queue/index.ts";
import type { JobQueue, QueueJob } from "../infra/queue/index.ts";
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
import { createFailedRun } from "./state/index.ts";
import { dispatchRunWebhook } from "./webhooks.ts";
import { prepareAndExecuteRun } from "./run-pipeline.ts";
import { asRecordOrNull } from "../lib/safe-json.ts";
import { getPackage, packageExists } from "./agent-service.ts";
import { getPackageConfig } from "./state/index.ts";
import { validateAgentReadiness } from "./agent-readiness.ts";
import type { ConnectionProfile } from "@appstrate/db/schema";
import {
  getProfileByIdUnsafe,
  resolveProviderProfiles,
  resolveScheduleProfileArgs,
  getAgentOrgProfile,
} from "./connection-profiles.ts";
import type { LoadedPackage, ProviderProfileMap } from "../types/index.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { ApiError, internalError } from "../lib/errors.ts";
import { validateInput } from "./schema.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { computeNextRun } from "../lib/cron.ts";
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
    input: asRecordOrNull(schedule.input) ?? undefined,
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
  const { scheduleId, packageId, connectionProfileId, orgId, input } = job.data;

  await triggerScheduledRun(scheduleId, packageId, connectionProfileId, orgId, input);

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
  input: Record<string, unknown> | undefined,
) {
  /** Create a failed run record + dispatch webhook so the user is notified. */
  async function failSchedule(error: string, actor: Actor | null = null): Promise<void> {
    const runId = `run_${crypto.randomUUID()}`;
    try {
      await createFailedRun(runId, packageId, actor, orgId, error, scheduleId, connectionProfileId);
      dispatchRunWebhook(orgId, "failed", runId, packageId, { error });
    } catch (err) {
      logger.error("Failed to create failed schedule run record", {
        scheduleId,
        runId,
        error: err instanceof Error ? err.message : String(err),
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

    // Load the agent's admin-configured org profile (validates it still exists)
    const agentOrgProfile = await getAgentOrgProfile(orgId, packageId);
    const { defaultUserProfileId, orgProfileId } = resolveScheduleProfileArgs(
      profile,
      connectionProfileId,
      agentOrgProfile?.id ?? null,
    );

    // Resolve provider profiles, config, and validate readiness (inlined preflight).
    // Schedules don't support per-provider overrides.
    let providerProfiles: ProviderProfileMap;
    let config: Record<string, unknown>;
    let preflightModelId: string | null;
    let preflightProxyId: string | null;
    try {
      const manifestProviders = resolveManifestProviders(agent.manifest);

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

      await validateAgentReadiness({
        agent,
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
        error: err instanceof Error ? err.message : String(err),
      });
      await failSchedule(
        `Preflight error: ${err instanceof Error ? err.message : String(err)}`,
        actor,
      );
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

    const result = await prepareAndExecuteRun({
      runId,
      agent,
      providerProfiles,
      orgId,
      actor,
      input,
      config,
      modelId: preflightModelId,
      proxyId: preflightProxyId,
      scheduleId,
      connectionProfileId,
    });

    if (!result.ok) {
      logger.warn("Scheduled run pipeline failed", {
        scheduleId,
        packageId,
        orgId,
        code: result.error.code,
        detail: result.error.message,
      });
      await failSchedule(result.error.message, actor);
      return;
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

  // Batch load unique agents
  const packageIds = [...new Set(schedules.map((s) => s.packageId))];
  const agents = await Promise.all(packageIds.map((id) => getPackage(id, orgId)));
  const agentMap = new Map(packageIds.map((id, i) => [id, agents[i] ?? null]));

  return Promise.all(
    schedules.map(async (schedule) => {
      const profile = profileMap.get(schedule.connectionProfileId);
      const agent = agentMap.get(schedule.packageId);

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
        agent ?? null,
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
