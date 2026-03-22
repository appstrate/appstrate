import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  getSchedule,
  listSchedules,
  listPackageSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
} from "../services/scheduler.ts";
import { isValidCron } from "../lib/cron.ts";
import { validateInput, schemaHasFileFields } from "../services/schema.ts";
import { requireFlow } from "../middleware/guards.ts";
import { invalidRequest, notFound } from "../lib/errors.ts";

export function createSchedulesRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/schedules — list all schedules (org-scoped)
  router.get("/schedules", async (c) => {
    const orgId = c.get("orgId");
    const schedules = await listSchedules(orgId);
    return c.json(schedules);
  });

  // GET /api/flows/:scope/:name/schedules — list schedules for a flow
  router.get("/flows/:scope{@[^/]+}/:name/schedules", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const orgId = c.get("orgId");
    const schedules = await listPackageSchedules(flow.id, orgId);
    return c.json(schedules);
  });

  // POST /api/flows/:scope/:name/schedules — create a schedule
  router.post("/flows/:scope{@[^/]+}/:name/schedules", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");

    const body = await c.req.json<{
      name?: string;
      cronExpression: string;
      timezone?: string;
      input?: Record<string, unknown>;
    }>();

    // Block scheduling for flows with file inputs
    const inputSchema = flow.manifest.input?.schema;
    if (schemaHasFileFields(inputSchema)) {
      throw invalidRequest("Cannot schedule flows with file inputs");
    }

    if (!body.cronExpression) {
      throw invalidRequest("cronExpression is required", "cronExpression");
    }

    // Validate cron expression
    if (!isValidCron(body.cronExpression)) {
      throw invalidRequest("Invalid cron expression", "cronExpression");
    }

    // Validate input against flow's input schema if provided
    if (body.input && inputSchema) {
      const inputValidation = validateInput(body.input, inputSchema);
      if (!inputValidation.valid) {
        const first = inputValidation.errors[0]!;
        throw invalidRequest(first.message);
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
      throw notFound(`Schedule '${id}' not found`);
    }

    const body = await c.req.json<{
      name?: string;
      cronExpression?: string;
      timezone?: string;
      input?: Record<string, unknown>;
      enabled?: boolean;
    }>();

    // Validate cron expression if provided
    if (body.cronExpression && !isValidCron(body.cronExpression)) {
      throw invalidRequest("Invalid cron expression", "cronExpression");
    }

    const schedule = await updateSchedule(id, body);
    return c.json(schedule);
  });

  // DELETE /api/schedules/:id — delete a schedule
  router.delete("/schedules/:id", async (c) => {
    const id = c.req.param("id");
    const deleted = await deleteSchedule(id);
    if (!deleted) {
      throw notFound(`Schedule '${id}' not found`);
    }
    return c.json({ ok: true });
  });

  return router;
}
