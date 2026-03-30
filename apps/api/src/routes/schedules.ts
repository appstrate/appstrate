import { Hono } from "hono";
import { z } from "zod";
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
import { requireAdmin, requireFlow } from "../middleware/guards.ts";
import { forbidden, invalidRequest, notFound, parseBody } from "../lib/errors.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { getProfileForActor } from "../services/connection-profiles.ts";
import { getActor } from "../lib/actor.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";

const createScheduleSchema = z.object({
  name: z.string().optional(),
  connectionProfileId: z.uuid(),
  cronExpression: z.string().min(1, "cronExpression is required"),
  timezone: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});

const updateScheduleSchema = z.object({
  connectionProfileId: z.uuid().optional(),
  name: z.string().optional(),
  cronExpression: z.string().optional(),
  timezone: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

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
  router.post(
    "/flows/:scope{@[^/]+}/:name/schedules",
    rateLimit(10),
    requireAdmin(),
    requireFlow(),
    async (c) => {
      const flow = c.get("flow");
      const actor = getActor(c);

      const body = await c.req.json();
      const data = parseBody(createScheduleSchema, body);

      // Validate ownership — user can only schedule with their own profiles
      const profile = await getProfileForActor(data.connectionProfileId, actor);
      if (!profile) {
        throw forbidden("Cannot use a profile you do not own");
      }

      // Block scheduling for flows with file inputs
      const inputSchema = flow.manifest.input?.schema;
      if (schemaHasFileFields(inputSchema ? asJSONSchemaObject(inputSchema) : undefined)) {
        throw invalidRequest("Cannot schedule flows with file inputs");
      }

      // Validate cron expression
      if (!isValidCron(data.cronExpression)) {
        throw invalidRequest("Invalid cron expression", "cronExpression");
      }

      // Validate input against flow's input schema (catches missing required fields even when input is undefined)
      if (inputSchema) {
        const inputValidation = validateInput(data.input, asJSONSchemaObject(inputSchema));
        if (!inputValidation.valid) {
          const first = inputValidation.errors[0]!;
          throw invalidRequest(first.message, first.field);
        }
      }

      const schedule = await createSchedule(
        flow.id,
        data.connectionProfileId,
        c.get("orgId"),
        data,
      );
      return c.json(schedule, 201);
    },
  );

  // GET /api/schedules/:id — get a single schedule
  router.get("/schedules/:id", async (c) => {
    const id = c.req.param("id");
    const orgId = c.get("orgId");
    const schedule = await getSchedule(id);
    if (!schedule || schedule.orgId !== orgId) {
      throw notFound(`Schedule '${id}' not found`);
    }
    return c.json(schedule);
  });

  // PUT /api/schedules/:id — update a schedule
  router.put("/schedules/:id", requireAdmin(), async (c) => {
    const id = c.req.param("id")!;
    const orgId = c.get("orgId");
    const existing = await getSchedule(id);
    if (!existing || existing.orgId !== orgId) {
      throw notFound(`Schedule '${id}' not found`);
    }

    const body = await c.req.json();
    const data = parseBody(updateScheduleSchema, body);

    // Validate ownership — user can only update schedule to use their own profiles
    if (data.connectionProfileId) {
      const actor = getActor(c);
      const profile = await getProfileForActor(data.connectionProfileId, actor);
      if (!profile) {
        throw forbidden("Cannot use a profile you do not own");
      }
    }

    // Validate cron expression if provided
    if (data.cronExpression && !isValidCron(data.cronExpression)) {
      throw invalidRequest("Invalid cron expression", "cronExpression");
    }

    const schedule = await updateSchedule(id, data);
    return c.json(schedule);
  });

  // DELETE /api/schedules/:id — delete a schedule
  router.delete("/schedules/:id", requireAdmin(), async (c) => {
    const id = c.req.param("id")!;
    const orgId = c.get("orgId");
    const existing = await getSchedule(id);
    if (!existing || existing.orgId !== orgId) {
      throw notFound(`Schedule '${id}' not found`);
    }
    await deleteSchedule(id);
    return c.json({ ok: true });
  });

  return router;
}
