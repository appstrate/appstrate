import { Queue, Worker } from "bullmq";
import type { Job, ConnectionOptions } from "bullmq";
import { eq, and, asc } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { packageSchedules } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import type { Schedule } from "@appstrate/shared-types";
import { createExecution } from "./state/index.ts";
import { executeFlowInBackground } from "../routes/executions.ts";
import {
  buildExecutionContext,
  resolvePreflightContext,
  ModelNotConfiguredError,
} from "./env-builder.ts";
import type { PromptContext } from "./adapters/types.ts";
import { getPackage, packageExists } from "./flow-service.ts";
import { getEffectiveProfileId } from "./connection-profiles.ts";
import { ApiError } from "../lib/errors.ts";
import { validateInput } from "./schema.ts";
import { getRedisConnection } from "../lib/redis.ts";
import { computeNextRun } from "../lib/cron.ts";
import { getRunningExecutionCountForOrg } from "./state/index.ts";
import { getCloudModule } from "../lib/cloud-loader.ts";
import { type Actor, actorInsert } from "../lib/actor.ts";
import { getEndUserApplicationId } from "./end-users.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScheduleJobData {
  scheduleId: string;
  packageId: string;
  userId?: string;
  endUserId?: string;
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
    input:
      row.input !== null && typeof row.input === "object" && !Array.isArray(row.input)
        ? (row.input as Record<string, unknown>)
        : null,
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
    userId: schedule.userId ?? undefined,
    endUserId: schedule.endUserId ?? undefined,
    orgId,
    input:
      schedule.input !== null &&
      typeof schedule.input === "object" &&
      !Array.isArray(schedule.input)
        ? (schedule.input as Record<string, unknown>)
        : undefined,
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
  const { scheduleId, packageId, userId, endUserId, orgId, input } = job.data;

  const actor: Actor = endUserId
    ? { type: "end_user", id: endUserId }
    : { type: "member", id: userId! };

  await triggerScheduledExecution(scheduleId, packageId, actor, orgId, input);

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
  actor: Actor,
  orgId: string,
  input: Record<string, unknown> | undefined,
) {
  try {
    const flow = await getPackage(packageId, orgId);
    if (!flow) {
      logger.warn("Package not found, skipping schedule", { packageId, scheduleId });
      return;
    }

    // Resolve provider profiles, config, and validate readiness
    let providerProfiles: Record<string, string>;
    let config: Record<string, unknown>;
    try {
      ({ providerProfiles, config } = await resolvePreflightContext({
        flow,
        actor,
        packageId,
        orgId,
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
      const inputValidation = validateInput(input, inputSchema);
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
    const userProfileId = await getEffectiveProfileId(actor, packageId);

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

    // Resolve application context for execution record and webhook dispatch
    const applicationId =
      actor.type === "end_user" ? await getEndUserApplicationId(actor.id) : null;

    // Create execution record with schedule_id and version
    await createExecution(
      executionId,
      packageId,
      actor,
      orgId,
      input ?? null,
      scheduleId,
      packageVersionId ?? undefined,
      userProfileId,
      proxyLabel ?? undefined,
      modelLabel ?? undefined,
      applicationId,
    );

    logger.info("Triggering scheduled execution", {
      executionId,
      packageId,
      scheduleId,
      actorType: actor.type,
      actorId: actor.id,
      orgId,
    });

    // Fire-and-forget (catch to prevent unhandled rejection)
    executeFlowInBackground(
      executionId,
      actor,
      orgId,
      flow,
      promptContext,
      flowPackage,
      undefined,
      applicationId,
    ).catch((err) => {
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

export async function listSchedules(orgId: string): Promise<Schedule[]> {
  const rows = await db
    .select()
    .from(packageSchedules)
    .where(eq(packageSchedules.orgId, orgId))
    .orderBy(asc(packageSchedules.createdAt));
  return rows.map(toSchedule);
}

export async function listPackageSchedules(packageId: string, orgId: string): Promise<Schedule[]> {
  const rows = await db
    .select()
    .from(packageSchedules)
    .where(and(eq(packageSchedules.packageId, packageId), eq(packageSchedules.orgId, orgId)))
    .orderBy(asc(packageSchedules.createdAt));
  return rows.map(toSchedule);
}

export async function getSchedule(id: string): Promise<Schedule | null> {
  const rows = await db.select().from(packageSchedules).where(eq(packageSchedules.id, id)).limit(1);
  if (!rows[0]) return null;
  return toSchedule(rows[0]);
}

export async function createSchedule(
  packageId: string,
  actor: Actor,
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
      ...actorInsert(actor),
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
    throw new Error("Failed to create schedule: no row returned");
  }
  const schedule = toSchedule(row);

  await upsertScheduleJob(schedule, orgId);

  return schedule;
}

export async function updateSchedule(
  id: string,
  data: {
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
  if (data.name !== undefined) payload.name = data.name;
  if (data.input !== undefined) payload.input = data.input;

  const [row] = await db
    .update(packageSchedules)
    .set(payload)
    .where(eq(packageSchedules.id, id))
    .returning();

  if (!row) {
    throw new Error(`Failed to update schedule ${id}: no row returned`);
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
