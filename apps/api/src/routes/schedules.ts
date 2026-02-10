import { Hono } from "hono";
import { Cron } from "croner";
import type { LoadedFlow } from "../types/index.ts";
import {
  getAllSchedules,
  getSchedulesByFlow,
  getSchedule,
  createSchedule,
  updateSchedule,
  deleteSchedule,
} from "../services/scheduler.ts";
import { validateRequiredInput } from "../services/validation.ts";

export function createSchedulesRouter(flows: Map<string, LoadedFlow>) {
  const router = new Hono();

  // GET /api/schedules — list all schedules
  router.get("/schedules", async (c) => {
    const schedules = await getAllSchedules();
    return c.json({ schedules });
  });

  // GET /api/flows/:id/schedules — list schedules for a flow
  router.get("/flows/:id/schedules", async (c) => {
    const flowId = c.req.param("id");
    const flow = flows.get(flowId);
    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: `Flow '${flowId}' not found` }, 404);
    }
    const schedules = await getSchedulesByFlow(flowId);
    return c.json({ flowId, schedules });
  });

  // POST /api/flows/:id/schedules — create a schedule
  router.post("/flows/:id/schedules", async (c) => {
    const flowId = c.req.param("id");
    const flow = flows.get(flowId);
    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: `Flow '${flowId}' not found` }, 404);
    }

    const body = await c.req.json<{
      name?: string;
      cronExpression: string;
      timezone?: string;
      input?: Record<string, unknown>;
    }>();

    if (!body.cronExpression) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "cronExpression is required" },
        400,
      );
    }

    // Validate cron expression
    try {
      new Cron(body.cronExpression, { paused: true });
    } catch {
      return c.json(
        { error: "VALIDATION_ERROR", message: "Invalid cron expression" },
        400,
      );
    }

    // Validate input against flow's input schema if provided
    const inputSchema = flow.manifest.input?.schema;
    if (body.input && inputSchema) {
      const inputError = validateRequiredInput(body.input, inputSchema);
      if (inputError) {
        return c.json(
          { error: "VALIDATION_ERROR", message: inputError.message },
          400,
        );
      }
    }

    const schedule = await createSchedule(flowId, body);
    return c.json(schedule, 201);
  });

  // GET /api/schedules/:id — get a single schedule
  router.get("/schedules/:id", async (c) => {
    const id = c.req.param("id");
    const schedule = await getSchedule(id);
    if (!schedule) {
      return c.json({ error: "NOT_FOUND", message: `Schedule '${id}' not found` }, 404);
    }
    return c.json(schedule);
  });

  // PUT /api/schedules/:id — update a schedule
  router.put("/schedules/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await getSchedule(id);
    if (!existing) {
      return c.json({ error: "NOT_FOUND", message: `Schedule '${id}' not found` }, 404);
    }

    const body = await c.req.json<{
      name?: string;
      cronExpression?: string;
      timezone?: string;
      input?: Record<string, unknown>;
      enabled?: boolean;
    }>();

    // Validate cron expression if provided
    if (body.cronExpression) {
      try {
        new Cron(body.cronExpression, { paused: true });
      } catch {
        return c.json(
          { error: "VALIDATION_ERROR", message: "Invalid cron expression" },
          400,
        );
      }
    }

    const schedule = await updateSchedule(id, body);
    return c.json(schedule);
  });

  // DELETE /api/schedules/:id — delete a schedule
  router.delete("/schedules/:id", async (c) => {
    const id = c.req.param("id");
    const deleted = await deleteSchedule(id);
    if (!deleted) {
      return c.json({ error: "NOT_FOUND", message: `Schedule '${id}' not found` }, 404);
    }
    return c.json({ ok: true });
  });

  return router;
}
