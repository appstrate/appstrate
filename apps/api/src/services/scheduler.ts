import { Cron } from "croner";
import { supabase } from "../lib/supabase.ts";
import type { LoadedFlow } from "../types/index.ts";
import type { Schedule, Json } from "@appstrate/shared-types";
import { getFlowConfig, getFlowState, createExecution } from "./state.ts";
import { getConnectionStatus, getAccessToken } from "./nango.ts";
import { executeFlowInBackground, interpolatePrompt } from "../routes/executions.ts";
import { buildContainerEnv } from "./env-builder.ts";

// In-memory map of active cron jobs
const activeJobs = new Map<string, Cron>();
let loadedFlows: Map<string, LoadedFlow> = new Map();

// --- CRUD helpers ---

export async function getSchedule(id: string): Promise<Schedule | null> {
  const { data } = await supabase.from("flow_schedules").select("*").eq("id", id).single();
  return data ?? null;
}

export async function createSchedule(
  flowId: string,
  userId: string,
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

  // Start the cron job
  startCronJob(schedule);

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
    startCronJob(schedule);
  }

  return schedule;
}

export async function deleteSchedule(id: string): Promise<boolean> {
  stopCronJob(id);
  const { data } = await supabase.from("flow_schedules").delete().eq("id", id).select("id");
  return (data?.length ?? 0) > 0;
}

// --- Cron job management ---

function startCronJob(schedule: Schedule) {
  if (activeJobs.has(schedule.id)) return;

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
  input?: Record<string, unknown>,
) {
  try {
    const flow = loadedFlows.get(flowId);
    if (!flow) {
      console.warn(`[scheduler] Flow '${flowId}' not found, skipping schedule ${scheduleId}`);
      return;
    }

    // Validate service dependencies — skip if not connected
    const tokens: Record<string, string> = {};
    for (const svc of flow.manifest.requires.services) {
      const conn = await getConnectionStatus(svc.provider, userId);
      if (conn.status !== "connected") {
        console.warn(
          `[scheduler] Service '${svc.id}' not connected for user ${userId}, skipping schedule ${scheduleId} for flow '${flowId}'`,
        );
        return;
      }
      const token = await getAccessToken(svc.provider, userId);
      if (token) tokens[svc.id] = token;
    }

    // Get config and state
    const config = await getFlowConfig(flowId);
    const state = await getFlowState(userId, flowId);
    const inputValues = input ?? {};

    // Interpolate prompt
    const prompt = interpolatePrompt(flow.prompt, config, state, inputValues);

    // Prepare env vars
    const executionId = `exec_${crypto.randomUUID()}`;
    const envVars = buildContainerEnv({
      flowId,
      executionId,
      prompt,
      tokens,
      config,
      state,
      input,
      skills: flow.skills.filter((s) => s.content).map((s) => ({ id: s.id, content: s.content! })),
    });

    // Create execution record with schedule_id
    await createExecution(executionId, flowId, userId, input ?? null, scheduleId);

    console.log(
      `[scheduler] Triggering execution ${executionId} for flow '${flowId}' (schedule ${scheduleId}, user ${userId})`,
    );

    // Fire-and-forget (catch to prevent unhandled rejection)
    executeFlowInBackground(executionId, flowId, userId, flow, envVars, tokens).catch((err) => {
      console.error(`[scheduler] Unhandled error in execution ${executionId}:`, err);
    });

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
    console.error(
      `[scheduler] Failed to trigger schedule ${scheduleId} for flow '${flowId}':`,
      err,
    );
  }
}

// --- Lifecycle ---

export async function initScheduler(flows: Map<string, LoadedFlow>) {
  loadedFlows = flows;

  const { data } = await supabase.from("flow_schedules").select("*").eq("enabled", true);
  const schedules = data ?? [];

  let started = 0;
  for (const schedule of schedules) {
    if (!flows.has(schedule.flow_id)) {
      console.warn(
        `[scheduler] Schedule ${schedule.id} references missing flow '${schedule.flow_id}', skipping`,
      );
      continue;
    }
    startCronJob(schedule);
    started++;
  }

  if (started > 0) {
    console.log(`[scheduler] Started ${started} cron job(s)`);
  }
}

export function shutdownScheduler() {
  for (const [id, job] of activeJobs) {
    job.stop();
    activeJobs.delete(id);
  }
  console.log("[scheduler] All cron jobs stopped");
}
