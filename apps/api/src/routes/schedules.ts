// SPDX-License-Identifier: Apache-2.0

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
import { requireAgent } from "../middleware/guards.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { forbidden, invalidRequest, notFound, parseBody } from "../lib/errors.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { getAccessibleProfile } from "../services/connection-profiles.ts";
import { getActor } from "../lib/actor.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { listScheduleRuns } from "../services/state/index.ts";

export const createScheduleSchema = z.object({
  name: z.string().optional(),
  connectionProfileId: z.uuid(),
  cronExpression: z.string().min(1, "cronExpression is required"),
  timezone: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});

export const updateScheduleSchema = z.object({
  connectionProfileId: z.uuid().optional(),
  name: z.string().optional(),
  cronExpression: z.string().optional(),
  timezone: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

export function createSchedulesRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/schedules — list all schedules (app-scoped)
  router.get("/schedules", async (c) => {
    const orgId = c.get("orgId");
    const schedules = await listSchedules(orgId, c.get("applicationId"));
    return c.json(schedules);
  });

  // GET /api/agents/:scope/:name/schedules — list schedules for an agent
  router.get("/agents/:scope{@[^/]+}/:name/schedules", requireAgent(), async (c) => {
    const agent = c.get("agent");
    const orgId = c.get("orgId");
    const schedules = await listPackageSchedules(agent.id, orgId, c.get("applicationId"));
    return c.json(schedules);
  });

  // POST /api/agents/:scope/:name/schedules — create a schedule
  router.post(
    "/agents/:scope{@[^/]+}/:name/schedules",
    rateLimit(10),
    requireAgent(),
    requirePermission("schedules", "write"),
    async (c) => {
      const agent = c.get("agent");
      const actor = getActor(c);

      const body = await c.req.json();
      const data = parseBody(createScheduleSchema, body);

      // Validate ownership — user can only schedule with their own profiles
      const profile = await getAccessibleProfile(
        data.connectionProfileId,
        actor,
        c.get("applicationId"),
      );
      if (!profile) {
        throw forbidden("Cannot use a profile you do not own");
      }

      // Block scheduling for agents with file inputs
      const inputSchema = agent.manifest.input?.schema;
      if (schemaHasFileFields(inputSchema ? asJSONSchemaObject(inputSchema) : undefined)) {
        throw invalidRequest("Cannot schedule agents with file inputs");
      }

      // Validate cron expression
      if (!isValidCron(data.cronExpression)) {
        throw invalidRequest("Invalid cron expression", "cronExpression");
      }

      // Validate input against agent's input schema (catches missing required fields even when input is undefined)
      if (inputSchema) {
        const inputValidation = validateInput(data.input, asJSONSchemaObject(inputSchema));
        if (!inputValidation.valid) {
          const first = inputValidation.errors[0]!;
          throw invalidRequest(first.message, first.field);
        }
      }

      const schedule = await createSchedule(
        agent.id,
        data.connectionProfileId,
        c.get("orgId"),
        c.get("applicationId"),
        data,
      );
      return c.json(schedule, 201);
    },
  );

  // GET /api/schedules/:id — get a single schedule
  router.get("/schedules/:id", async (c) => {
    const id = c.req.param("id");
    const schedule = await getSchedule(id, c.get("orgId"), c.get("applicationId"));
    if (!schedule) {
      throw notFound(`Schedule '${id}' not found`);
    }
    return c.json(schedule);
  });

  // PUT /api/schedules/:id — update a schedule
  router.put("/schedules/:id", requirePermission("schedules", "write"), async (c) => {
    const id = c.req.param("id")!;
    const orgId = c.get("orgId");
    const existing = await getSchedule(id, orgId, c.get("applicationId"));
    if (!existing) {
      throw notFound(`Schedule '${id}' not found`);
    }

    const body = await c.req.json();
    const data = parseBody(updateScheduleSchema, body);

    // Validate ownership — only check when the profile is actually changing
    if (data.connectionProfileId && data.connectionProfileId !== existing.connectionProfileId) {
      const actor = getActor(c);
      const profile = await getAccessibleProfile(
        data.connectionProfileId,
        actor,
        c.get("applicationId"),
      );
      if (!profile) {
        throw forbidden("Cannot use a profile you do not own");
      }
    }

    // Validate cron expression if provided
    if (data.cronExpression && !isValidCron(data.cronExpression)) {
      throw invalidRequest("Invalid cron expression", "cronExpression");
    }

    const schedule = await updateSchedule(id, orgId, c.get("applicationId"), data);
    return c.json(schedule);
  });

  // DELETE /api/schedules/:id — delete a schedule
  router.delete("/schedules/:id", requirePermission("schedules", "delete"), async (c) => {
    const id = c.req.param("id")!;
    const orgId = c.get("orgId");
    const applicationId = c.get("applicationId");
    const existing = await getSchedule(id, orgId, applicationId);
    if (!existing) {
      throw notFound(`Schedule '${id}' not found`);
    }
    await deleteSchedule(id, orgId, applicationId);
    return c.json({ ok: true });
  });

  // GET /api/schedules/:id/runs — list runs for a schedule
  router.get("/schedules/:id/runs", async (c) => {
    const scheduleId = c.req.param("id");
    const orgId = c.get("orgId");
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .catch(20)
      .parse(c.req.query("limit") ?? 20);
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .catch(0)
      .parse(c.req.query("offset") ?? 0);
    const result = await listScheduleRuns(scheduleId, orgId, {
      limit,
      offset,
      applicationId: c.get("applicationId"),
    });
    return c.json(result);
  });

  return router;
}
