import { Cron } from "croner";
import sql from "../db/client.ts";
import type { LoadedFlow } from "../types/index.ts";
import type { Schedule } from "@appstrate/shared-types";
import {
  getFlowConfig,
  getFlowState,
  createExecution,
} from "./state.ts";
import { getConnectionStatus, getAccessToken } from "./nango.ts";
import { executeFlowInBackground, interpolatePrompt } from "../routes/executions.ts";
import { buildContainerEnv } from "./env-builder.ts";

// In-memory map of active cron jobs
const activeJobs = new Map<string, Cron>();
let loadedFlows: Map<string, LoadedFlow> = new Map();

// --- CRUD helpers ---

export async function getAllSchedules(): Promise<Schedule[]> {
  const rows = await sql`
    SELECT * FROM flow_schedules
    ORDER BY created_at DESC
  `;
  return rows as unknown as Schedule[];
}

export async function getSchedulesByFlow(flowId: string): Promise<Schedule[]> {
  const rows = await sql`
    SELECT * FROM flow_schedules
    WHERE flow_id = ${flowId}
    ORDER BY created_at DESC
  `;
  return rows as unknown as Schedule[];
}

export async function getSchedule(id: string): Promise<Schedule | null> {
  const rows = await sql`SELECT * FROM flow_schedules WHERE id = ${id}`;
  return (rows[0] as unknown as Schedule) ?? null;
}

export async function createSchedule(
  flowId: string,
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

  const rows = await sql`
    INSERT INTO flow_schedules (id, flow_id, name, enabled, cron_expression, timezone, input, next_run_at)
    VALUES (
      ${id}, ${flowId}, ${data.name ?? null}, true,
      ${data.cronExpression}, ${tz},
      ${data.input ? sql.json(data.input) : null},
      ${nextRun ? nextRun.toISOString() : null}
    )
    RETURNING *
  `;

  const schedule = rows[0] as unknown as Schedule;

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
  const tz = data.timezone ?? existing.timezone;
  const enabled = data.enabled ?? existing.enabled;

  // Compute next run
  const cron = new Cron(cronExpr, { timezone: tz, paused: true });
  const nextRun = enabled ? cron.nextRun() : null;

  const rows = await sql`
    UPDATE flow_schedules SET
      name = ${data.name !== undefined ? data.name : existing.name},
      cron_expression = ${cronExpr},
      timezone = ${tz},
      input = ${data.input !== undefined ? (data.input ? sql.json(data.input) : null) : sql`input`},
      enabled = ${enabled},
      next_run_at = ${nextRun ? nextRun.toISOString() : null},
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;

  const schedule = rows[0] as unknown as Schedule;

  // Restart or stop the cron job
  stopCronJob(id);
  if (schedule.enabled) {
    startCronJob(schedule);
  }

  return schedule;
}

export async function deleteSchedule(id: string): Promise<boolean> {
  stopCronJob(id);
  const rows = await sql`DELETE FROM flow_schedules WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

// --- Cron job management ---

function startCronJob(schedule: Schedule) {
  if (activeJobs.has(schedule.id)) return;

  const job = new Cron(schedule.cron_expression, {
    timezone: schedule.timezone,
    protect: true, // Prevent overlapping runs
  }, () => {
    triggerScheduledExecution(schedule.id, schedule.flow_id, schedule.input ?? undefined);
  });

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
      const conn = await getConnectionStatus(svc.provider);
      if (conn.status !== "connected") {
        console.warn(
          `[scheduler] Service '${svc.id}' not connected, skipping schedule ${scheduleId} for flow '${flowId}'`,
        );
        return;
      }
      const token = await getAccessToken(svc.provider);
      if (token) tokens[svc.id] = token;
    }

    // Get config and state
    const config = await getFlowConfig(flowId);
    const state = await getFlowState(flowId);
    const inputValues = input ?? {};

    // Interpolate prompt
    const prompt = interpolatePrompt(flow.prompt, config, state, inputValues);

    // Prepare env vars
    const executionId = `exec_${crypto.randomUUID()}`;
    const envVars = buildContainerEnv({ flowId, executionId, prompt, tokens, config, state, input });

    // Create execution record with schedule_id
    await createExecution(executionId, flowId, input ?? null, scheduleId);

    console.log(`[scheduler] Triggering execution ${executionId} for flow '${flowId}' (schedule ${scheduleId})`);

    // Fire-and-forget (catch to prevent unhandled rejection)
    executeFlowInBackground(executionId, flowId, flow, envVars, tokens).catch((err) => {
      console.error(`[scheduler] Unhandled error in execution ${executionId}:`, err);
    });

    // Update schedule timestamps
    const job = activeJobs.get(scheduleId);
    const nextRun = job?.nextRun() ?? null;

    await sql`
      UPDATE flow_schedules SET
        last_run_at = NOW(),
        next_run_at = ${nextRun ? nextRun.toISOString() : null},
        updated_at = NOW()
      WHERE id = ${scheduleId}
    `;
  } catch (err) {
    console.error(`[scheduler] Failed to trigger schedule ${scheduleId} for flow '${flowId}':`, err);
  }
}

// --- Lifecycle ---

export async function initScheduler(flows: Map<string, LoadedFlow>) {
  loadedFlows = flows;

  const rows = await sql`
    SELECT * FROM flow_schedules WHERE enabled = true
  `;
  const schedules = rows as unknown as Schedule[];

  let started = 0;
  for (const schedule of schedules) {
    if (!flows.has(schedule.flow_id)) {
      console.warn(`[scheduler] Schedule ${schedule.id} references missing flow '${schedule.flow_id}', skipping`);
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
