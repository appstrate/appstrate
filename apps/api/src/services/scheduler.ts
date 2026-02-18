import { hostname } from "node:os";
import { Cron } from "croner";
import { supabase } from "../lib/supabase.ts";
import { logger } from "../lib/logger.ts";
import type { Schedule, Json } from "@appstrate/shared-types";
import {
  getFlowConfig,
  getLastExecutionState,
  createExecution,
  getAdminConnections,
} from "./state.ts";
import { getConnectionStatus, getAccessToken } from "./nango.ts";
import { executeFlowInBackground } from "../routes/executions.ts";
import { buildPromptContext, buildExecutionApi } from "./env-builder.ts";
import { getFlowPackage } from "./flow-package.ts";
import { getFlow, flowExists } from "./flow-service.ts";
import { getLatestVersionId } from "./flow-versions.ts";

// In-memory map of active cron jobs
const activeJobs = new Map<string, Cron>();

// Unique instance identifier for distributed locking
const INSTANCE_ID = `${hostname()}-${process.pid}`;

// Cache schedule orgId for trigger context
const scheduleOrgCache = new Map<string, string>();

// --- CRUD helpers ---

export async function getSchedule(id: string): Promise<Schedule | null> {
  const { data } = await supabase.from("flow_schedules").select("*").eq("id", id).single();
  return data ?? null;
}

export async function createSchedule(
  flowId: string,
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

  const { data: row, error } = await supabase
    .from("flow_schedules")
    .insert({
      id,
      flow_id: flowId,
      user_id: userId,
      org_id: orgId,
      name: data.name ?? null,
      enabled: true,
      cron_expression: data.cronExpression,
      timezone: tz,
      input: (data.input ?? null) as Json,
      next_run_at: nextRun ? nextRun.toISOString() : null,
    })
    .select("*")
    .single();

  if (error || !row) {
    throw new Error(`Failed to create schedule: ${error?.message ?? "no row returned"}`);
  }
  const schedule = row;

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

  const cronExpr = data.cronExpression ?? existing.cron_expression;
  const tz = data.timezone ?? existing.timezone ?? "UTC";
  const enabled = data.enabled ?? existing.enabled;

  // Compute next run
  const cron = new Cron(cronExpr, { timezone: tz, paused: true });
  const nextRun = enabled ? cron.nextRun() : null;

  const payload: Record<string, unknown> = {
    cron_expression: cronExpr,
    timezone: tz,
    enabled,
    next_run_at: nextRun ? nextRun.toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  if (data.name !== undefined) payload.name = data.name;
  if (data.input !== undefined) payload.input = data.input;

  const { data: row, error } = await supabase
    .from("flow_schedules")
    .update(payload as Record<string, Json>)
    .eq("id", id)
    .select("*")
    .single();

  if (error || !row) {
    throw new Error(`Failed to update schedule ${id}: ${error?.message ?? "no row returned"}`);
  }
  const schedule = row;

  // Restart or stop the cron job
  stopCronJob(id);
  if (schedule.enabled) {
    const orgId = scheduleOrgCache.get(id) ?? (existing as unknown as { org_id: string }).org_id;
    startCronJob(schedule, orgId);
  }

  return schedule;
}

export async function deleteSchedule(id: string): Promise<boolean> {
  stopCronJob(id);
  scheduleOrgCache.delete(id);
  const { data } = await supabase.from("flow_schedules").delete().eq("id", id).select("id");
  return (data?.length ?? 0) > 0;
}

// --- Cron job management ---

function startCronJob(schedule: Schedule, orgId: string) {
  if (activeJobs.has(schedule.id)) return;

  // Cache orgId for later trigger use
  scheduleOrgCache.set(schedule.id, orgId);

  const job = new Cron(
    schedule.cron_expression,
    {
      timezone: schedule.timezone ?? "UTC",
      protect: true, // Prevent overlapping runs
    },
    () => {
      triggerScheduledExecution(
        schedule.id,
        schedule.flow_id,
        schedule.user_id,
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

async function triggerScheduledExecution(
  scheduleId: string,
  flowId: string,
  userId: string,
  orgId: string,
  input?: Record<string, unknown>,
) {
  try {
    // Distributed lock: prevent duplicate executions across instances
    const fireTime = new Date().toISOString();
    const { data: lockResult } = await supabase.rpc("try_acquire_schedule_lock", {
      p_schedule_id: scheduleId,
      p_fire_time: fireTime,
      p_instance_id: INSTANCE_ID,
    });

    if (!lockResult) {
      logger.info("Schedule lock not acquired, skipping (another instance won)", {
        scheduleId,
        fireTime,
      });
      return;
    }

    const flow = await getFlow(flowId, orgId);
    if (!flow) {
      logger.warn("Flow not found, skipping schedule", { flowId, scheduleId });
      return;
    }

    // Validate service dependencies — skip if not connected
    const adminConns = await getAdminConnections(orgId, flowId);
    const tokens: Record<string, string> = {};
    for (const svc of flow.manifest.requires.services) {
      const mode = svc.connectionMode ?? "user";
      let tokenUserId: string;

      if (mode === "admin") {
        const adminUserId = adminConns[svc.id];
        if (!adminUserId) {
          logger.warn("Admin service not bound, skipping schedule", {
            serviceId: svc.id,
            scheduleId,
            flowId,
          });
          return;
        }
        tokenUserId = adminUserId;
      } else {
        tokenUserId = userId;
      }

      const conn = await getConnectionStatus(svc.provider, orgId, tokenUserId);
      if (conn.status !== "connected") {
        logger.warn("Service not connected, skipping schedule", {
          serviceId: svc.id,
          userId: tokenUserId,
          scheduleId,
          flowId,
        });
        return;
      }
      const token = await getAccessToken(svc.provider, orgId, tokenUserId);
      if (token) tokens[svc.id] = token;
    }

    // Get config and previous state
    const config = await getFlowConfig(orgId, flowId);
    const previousState = await getLastExecutionState(flowId, userId, orgId);

    // Build prompt context
    const executionId = `exec_${crypto.randomUUID()}`;
    const promptContext = buildPromptContext({
      flow,
      tokens,
      config,
      previousState,
      executionApi: buildExecutionApi(executionId),
      input,
    });

    // Get flow package (ZIP) for injection into container
    const flowPackage = await getFlowPackage(flow);

    // Get flow version ID for user flows
    const flowVersionId =
      flow.source === "user" ? await getLatestVersionId(flowId).catch(() => null) : null;

    // Create execution record with schedule_id and version
    await createExecution(
      executionId,
      flowId,
      userId,
      orgId,
      input ?? null,
      scheduleId,
      flowVersionId ?? undefined,
    );

    // Link execution to the schedule run lock row
    await supabase
      .from("schedule_runs")
      .update({ execution_id: executionId })
      .eq("schedule_id", scheduleId)
      .eq("fire_time", fireTime);

    logger.info("Triggering scheduled execution", { executionId, flowId, scheduleId, userId, orgId });

    // Fire-and-forget (catch to prevent unhandled rejection)
    executeFlowInBackground(executionId, flowId, userId, orgId, flow, promptContext, flowPackage).catch(
      (err) => {
        logger.error("Unhandled error in scheduled execution", {
          executionId,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );

    // Update schedule timestamps
    const job = activeJobs.get(scheduleId);
    const nextRun = job?.nextRun() ?? null;

    await supabase
      .from("flow_schedules")
      .update({
        last_run_at: new Date().toISOString(),
        next_run_at: nextRun ? nextRun.toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", scheduleId);
  } catch (err) {
    logger.error("Failed to trigger schedule", {
      scheduleId,
      flowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- Lifecycle ---

export async function initScheduler() {
  const { data } = await supabase.from("flow_schedules").select("*").eq("enabled", true);
  const schedules = data ?? [];

  let started = 0;
  for (const schedule of schedules) {
    if (!(await flowExists(schedule.flow_id))) {
      logger.warn("Schedule references missing flow, skipping", {
        scheduleId: schedule.id,
        flowId: schedule.flow_id,
      });
      continue;
    }
    const orgId = (schedule as unknown as { org_id: string }).org_id;
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
