import { hostname } from "node:os";
import { Cron } from "croner";
import { eq, and, asc } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { packageSchedules, scheduleRuns } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import type { Schedule } from "@appstrate/shared-types";
import { createExecution } from "./state.ts";
import { getConnectionStatus } from "./connection-manager.ts";
import { executeFlowInBackground } from "../routes/executions.ts";
import { buildExecutionContext } from "./env-builder.ts";
import { getPackage, packageExists } from "./flow-service.ts";
import { resolveServiceProfiles, getEffectiveProfileId } from "./connection-profiles.ts";

// In-memory map of active cron jobs
const activeJobs = new Map<string, Cron>();

// Unique instance identifier for distributed locking
const INSTANCE_ID = `${hostname()}-${process.pid}`;

// Cache schedule orgId for trigger context
const scheduleOrgCache = new Map<string, string>();

/** Convert a Drizzle schedule row to the Schedule type. */
function toSchedule(row: typeof packageSchedules.$inferSelect): Schedule {
  return {
    ...row,
    input: row.input as Record<string, unknown> | null,
  };
}

// --- CRUD helpers ---

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
  userId: string,
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

  // Compute next run
  const cron = new Cron(data.cronExpression, { timezone: tz, paused: true });
  const nextRun = cron.nextRun();

  const [row] = await db
    .insert(packageSchedules)
    .values({
      id,
      packageId,
      userId,
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

  // Cache orgId and start the cron job
  scheduleOrgCache.set(schedule.id, orgId);
  startCronJob(schedule, orgId);

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

  // Compute next run
  const cron = new Cron(cronExpr, { timezone: tz, paused: true });
  const nextRun = enabled ? cron.nextRun() : null;

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

  // Restart or stop the cron job
  stopCronJob(id);
  if (schedule.enabled) {
    const orgId = scheduleOrgCache.get(id) ?? existing.orgId;
    startCronJob(schedule, orgId);
  }

  return schedule;
}

export async function deleteSchedule(id: string): Promise<boolean> {
  stopCronJob(id);
  scheduleOrgCache.delete(id);
  const deleted = await db
    .delete(packageSchedules)
    .where(eq(packageSchedules.id, id))
    .returning({ id: packageSchedules.id });
  return deleted.length > 0;
}

// --- Cron job management ---

function startCronJob(schedule: Schedule, orgId: string) {
  if (activeJobs.has(schedule.id)) return;

  // Cache orgId for later trigger use
  scheduleOrgCache.set(schedule.id, orgId);

  const job = new Cron(
    schedule.cronExpression,
    {
      timezone: schedule.timezone ?? "UTC",
      protect: true, // Prevent overlapping runs
    },
    () => {
      triggerScheduledExecution(
        schedule.id,
        schedule.packageId,
        schedule.userId,
        orgId,
        (schedule.input as Record<string, unknown>) ?? undefined,
      );
    },
  );

  activeJobs.set(schedule.id, job);
}

function stopCronJob(scheduleId: string) {
  const job = activeJobs.get(scheduleId);
  if (job) {
    job.stop();
    activeJobs.delete(scheduleId);
  }
}

/**
 * Distributed lock: try to acquire schedule lock via INSERT ON CONFLICT DO NOTHING.
 * Returns true if lock was acquired (row inserted), false if another instance won.
 */
async function tryAcquireScheduleLock(scheduleId: string, fireTime: Date): Promise<boolean> {
  try {
    const runId = `run_${crypto.randomUUID()}`;
    const result = await db
      .insert(scheduleRuns)
      .values({
        id: runId,
        scheduleId,
        fireTime,
        instanceId: INSTANCE_ID,
      })
      .onConflictDoNothing({ target: [scheduleRuns.scheduleId, scheduleRuns.fireTime] })
      .returning({ id: scheduleRuns.id });

    return result.length > 0;
  } catch {
    return false;
  }
}

async function triggerScheduledExecution(
  scheduleId: string,
  packageId: string,
  userId: string,
  orgId: string,
  input?: Record<string, unknown>,
) {
  try {
    // Distributed lock: prevent duplicate executions across instances
    const fireTime = new Date();
    const locked = await tryAcquireScheduleLock(scheduleId, fireTime);

    if (!locked) {
      logger.info("Schedule lock not acquired, skipping (another instance won)", {
        scheduleId,
        fireTime,
      });
      return;
    }

    const flow = await getPackage(packageId, orgId);
    if (!flow) {
      logger.warn("Package not found, skipping schedule", { packageId, scheduleId });
      return;
    }

    // Resolve service profiles for this user + package
    const serviceProfiles = await resolveServiceProfiles(
      flow.manifest.requires.services,
      userId,
      packageId,
      orgId,
    );

    // Validate service dependencies — skip if not connected
    for (const svc of flow.manifest.requires.services) {
      const profileId = serviceProfiles[svc.id];
      if (!profileId) {
        logger.warn("Service profile not resolved, skipping schedule", {
          serviceId: svc.id,
          scheduleId,
          packageId,
        });
        return;
      }

      const conn = await getConnectionStatus(svc.provider, profileId, orgId);
      if (conn.status !== "connected") {
        logger.warn("Service not connected, skipping schedule", {
          serviceId: svc.id,
          profileId,
          scheduleId,
          packageId,
        });
        return;
      }
    }

    const executionId = `exec_${crypto.randomUUID()}`;
    const userProfileId = await getEffectiveProfileId(userId, packageId);

    // Build execution context (tokens, config, state, providers, package, version)
    const { promptContext, flowPackage, flowVersionId } = await buildExecutionContext({
      executionId,
      flow,
      serviceProfiles,
      orgId,
      userId,
      input,
    });

    // Create execution record with schedule_id and version
    await createExecution(
      executionId,
      packageId,
      userId,
      orgId,
      input ?? null,
      scheduleId,
      flowVersionId ?? undefined,
      userProfileId,
    );

    // Link execution to the schedule run lock row
    await db
      .update(scheduleRuns)
      .set({ executionId })
      .where(and(eq(scheduleRuns.scheduleId, scheduleId), eq(scheduleRuns.fireTime, fireTime)));

    logger.info("Triggering scheduled execution", {
      executionId,
      packageId,
      scheduleId,
      userId,
      orgId,
    });

    // Fire-and-forget (catch to prevent unhandled rejection)
    executeFlowInBackground(
      executionId,
      packageId,
      userId,
      orgId,
      flow,
      promptContext,
      flowPackage,
    ).catch((err) => {
      logger.error("Unhandled error in scheduled execution", {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Update schedule timestamps
    const job = activeJobs.get(scheduleId);
    const nextRun = job?.nextRun() ?? null;

    await db
      .update(packageSchedules)
      .set({
        lastRunAt: new Date(),
        nextRunAt: nextRun ?? null,
        updatedAt: new Date(),
      })
      .where(eq(packageSchedules.id, scheduleId));
  } catch (err) {
    logger.error("Failed to trigger schedule", {
      scheduleId,
      packageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- Lifecycle ---

export async function initScheduler() {
  const rows = await db.select().from(packageSchedules).where(eq(packageSchedules.enabled, true));

  let started = 0;
  for (const row of rows) {
    if (!(await packageExists(row.packageId))) {
      logger.warn("Schedule references missing package, skipping", {
        scheduleId: row.id,
        packageId: row.packageId,
      });
      continue;
    }
    const orgId = row.orgId;
    const schedule = toSchedule(row);
    startCronJob(schedule, orgId);
    started++;
  }

  if (started > 0) {
    logger.info("Scheduler initialized", { cronJobsStarted: started });
  }
}

export function shutdownScheduler() {
  for (const [id, job] of activeJobs) {
    job.stop();
    activeJobs.delete(id);
  }
  scheduleOrgCache.clear();
  logger.info("All cron jobs stopped");
}
