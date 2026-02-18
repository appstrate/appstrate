import { Hono } from "hono";
import { Cron } from "croner";
import type { AppEnv } from "../types/index.ts";
import {
  getSchedule,
  createSchedule,
  updateSchedule,
  deleteSchedule,
} from "../services/scheduler.ts";
import { validateInput } from "../services/schema.ts";
import { requireFlow } from "../middleware/guards.ts";

export function createSchedulesRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/flows/:id/schedules — create a schedule
  router.post("/flows/:id/schedules", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");

    const body = await c.req.json<{
      name?: string;
      cronExpression: string;
      timezone?: string;
      input?: Record<string, unknown>;
    }>();

    if (!body.cronExpression) {
      return c.json({ error: "VALIDATION_ERROR", message: "cronExpression is required" }, 400);
    }

    // Validate cron expression
    try {
      new Cron(body.cronExpression, { paused: true });
    } catch {
      return c.json({ error: "VALIDATION_ERROR", message: "Invalid cron expression" }, 400);
    }

    // Validate input against flow's input schema if provided
    const inputSchema = flow.manifest.input?.schema;
    if (body.input && inputSchema) {
      const inputValidation = validateInput(body.input, inputSchema);
      if (!inputValidation.valid) {
        const first = inputValidation.errors[0]!;
        return c.json({ error: "VALIDATION_ERROR", message: first.message }, 400);
      }
    }

    const schedule = await createSchedule(flow.id, user.id, c.get("orgId"), body);
    return c.json(schedule, 201);
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
        return c.json({ error: "VALIDATION_ERROR", message: "Invalid cron expression" }, 400);
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
