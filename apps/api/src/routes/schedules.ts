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
import { validateInput } from "../services/schema.ts";
import { requireAgent } from "../middleware/guards.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { invalidRequest, notFound, parseBody, validationFailed } from "../lib/errors.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { getActor } from "../lib/actor.ts";
import { getAppScope } from "../lib/scope.ts";
import { assertExplicitModelExists } from "../services/org-models.ts";
import { asJSONSchemaObject, schemaHasFileFields } from "@appstrate/core/form";
import { listScheduleRuns } from "../services/state/runs.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import { setOffsetLinkHeader } from "../lib/pagination-link.ts";
import { runConfigOverrideSchema, scheduleInputSchema } from "../lib/jsonb-schemas.ts";

// Per-integration connection picks frozen on the schedule row (cascade
// mechanism #3). Same wire shape as the run-route's connection_overrides;
// loses to admin pins at fire time. Shape: { "@scope/integration": "<connection_id>" }.
const connectionOverridesSchema = z.record(z.string(), z.string());

export const createScheduleSchema = z.object({
  name: z.string().optional(),
  cron_expression: z.string().min(1, "cron_expression is required"),
  timezone: z.string().default("UTC"),
  input: scheduleInputSchema.default({}),
  // Per-schedule override layer — frozen at create/update and deep-merged
  // with the application's persisted config every time the schedule
  // fires. Mirrors the per-run override pipeline (POST /run body) so a
  // schedule is "a recurring run with frozen overrides".
  config_override: runConfigOverrideSchema.optional(),
  model_id_override: z.string().optional(),
  proxy_id_override: z.string().optional(),
  version_override: z.string().optional(),
  connection_overrides: connectionOverridesSchema.optional(),
});

export const updateScheduleSchema = z.object({
  name: z.string().optional(),
  cron_expression: z.string().optional(),
  timezone: z.string().optional(),
  input: scheduleInputSchema.optional(),
  enabled: z.boolean().optional(),
  // `null` clears the override; omitted leaves it untouched.
  config_override: runConfigOverrideSchema.nullable().optional(),
  model_id_override: z.string().nullable().optional(),
  proxy_id_override: z.string().nullable().optional(),
  version_override: z.string().nullable().optional(),
  connection_overrides: connectionOverridesSchema.nullable().optional(),
});

export function createSchedulesRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/schedules — list all schedules (app-scoped)
  router.get("/schedules", async (c) => {
    const scope = getAppScope(c);
    const schedules = await listSchedules(scope);
    return c.json(schedules);
  });

  // GET /api/agents/:scope/:name/schedules — list schedules for an agent
  router.get("/agents/:scope{@[^/]+}/:name/schedules", requireAgent(), async (c) => {
    const scope = getAppScope(c);
    const agent = c.get("package");
    const schedules = await listPackageSchedules(scope, agent.id);
    return c.json(schedules);
  });

  // POST /api/agents/:scope/:name/schedules — create a schedule
  router.post(
    "/agents/:scope{@[^/]+}/:name/schedules",
    rateLimit(10),
    requireAgent(),
    requirePermission("schedules", "write"),
    async (c) => {
      const agent = c.get("package");
      const actor = getActor(c);

      const body = await c.req.json();
      const data = parseBody(createScheduleSchema, body);

      // Block scheduling for agents with file inputs
      const inputSchema = agent.manifest.input?.schema;
      if (schemaHasFileFields(inputSchema ? asJSONSchemaObject(inputSchema) : undefined)) {
        throw invalidRequest("Cannot schedule agents with file inputs");
      }

      // Validate cron expression
      if (!isValidCron(data.cron_expression)) {
        throw invalidRequest("Invalid cron expression", "cron_expression");
      }

      // Validate input against agent's input schema (catches missing required fields even when input is undefined)
      if (inputSchema) {
        const inputValidation = validateInput(data.input, asJSONSchemaObject(inputSchema));
        if (!inputValidation.valid) {
          throw validationFailed(
            inputValidation.errors.map((e) => ({
              field: e.field ? `input.${e.field}` : "input",
              code: "invalid_input",
              title: "Invalid Input",
              message: e.message,
            })),
          );
        }
      }

      const scope = getAppScope(c);

      // Reject a `model_id_override` that references no real model up front, so
      // a bad id fails at schedule-create time instead of silently each tick.
      await assertExplicitModelExists(scope.orgId, data.model_id_override);

      const schedule = await createSchedule(scope, agent.id, actor, {
        name: data.name,
        cronExpression: data.cron_expression,
        timezone: data.timezone,
        input: data.input,
        configOverride: data.config_override ?? null,
        modelIdOverride: data.model_id_override ?? null,
        proxyIdOverride: data.proxy_id_override ?? null,
        versionOverride: data.version_override ?? null,
        connectionOverrides: data.connection_overrides ?? null,
      });
      await recordAuditFromContext(c, {
        action: "schedule.created",
        resourceType: "schedule",
        resourceId: schedule.id,
        after: {
          packageId: agent.id,
          cronExpression: data.cron_expression,
          timezone: data.timezone,
        },
      });
      return c.json(schedule, 201);
    },
  );

  // GET /api/schedules/:id — get a single schedule
  router.get("/schedules/:id", async (c) => {
    const id = c.req.param("id");
    const schedule = await getSchedule(id, getAppScope(c));
    if (!schedule) {
      throw notFound(`Schedule '${id}' not found`);
    }
    return c.json(schedule);
  });

  // PUT /api/schedules/:id — update a schedule
  router.put("/schedules/:id", requirePermission("schedules", "write"), async (c) => {
    const id = c.req.param("id")!;
    const scope = getAppScope(c);
    const existing = await getSchedule(id, scope);
    if (!existing) {
      throw notFound(`Schedule '${id}' not found`);
    }

    const body = await c.req.json();
    const data = parseBody(updateScheduleSchema, body);

    // Validate cron expression if provided
    if (data.cron_expression && !isValidCron(data.cron_expression)) {
      throw invalidRequest("Invalid cron expression", "cron_expression");
    }

    // Reject a `model_id_override` that references no real model (no-op when
    // the field isn't part of this patch).
    await assertExplicitModelExists(scope.orgId, data.model_id_override);

    // Translate snake_case wire fields to internal camelCase for the service.
    const schedule = await updateSchedule(scope, id, {
      name: data.name,
      cronExpression: data.cron_expression,
      timezone: data.timezone,
      input: data.input,
      enabled: data.enabled,
      configOverride: data.config_override,
      modelIdOverride: data.model_id_override,
      proxyIdOverride: data.proxy_id_override,
      versionOverride: data.version_override,
      connectionOverrides: data.connection_overrides,
    });
    // Mirror schedule.created: explicit camelCase keys (dominant audit
    // convention — see api-keys.ts, modules/webhooks/routes.ts). Only
    // include keys the caller actually sent so the audit reflects the
    // patch, not a snapshot of the whole row.
    const auditAfter: Record<string, unknown> = {};
    if (data.name !== undefined) auditAfter.name = data.name;
    if (data.cron_expression !== undefined) auditAfter.cronExpression = data.cron_expression;
    if (data.timezone !== undefined) auditAfter.timezone = data.timezone;
    if (data.input !== undefined) auditAfter.input = data.input;
    if (data.enabled !== undefined) auditAfter.enabled = data.enabled;
    if (data.config_override !== undefined) auditAfter.configOverride = data.config_override;
    if (data.model_id_override !== undefined) auditAfter.modelIdOverride = data.model_id_override;
    if (data.proxy_id_override !== undefined) auditAfter.proxyIdOverride = data.proxy_id_override;
    if (data.version_override !== undefined) auditAfter.versionOverride = data.version_override;
    if (data.connection_overrides !== undefined)
      auditAfter.connectionOverrides = data.connection_overrides;
    await recordAuditFromContext(c, {
      action: "schedule.updated",
      resourceType: "schedule",
      resourceId: id,
      after: auditAfter,
    });
    return c.json(schedule);
  });

  // DELETE /api/schedules/:id — delete a schedule
  router.delete("/schedules/:id", requirePermission("schedules", "delete"), async (c) => {
    const id = c.req.param("id")!;
    const scope = getAppScope(c);
    const existing = await getSchedule(id, scope);
    if (!existing) {
      throw notFound(`Schedule '${id}' not found`);
    }
    await deleteSchedule(scope, id);
    await recordAuditFromContext(c, {
      action: "schedule.deleted",
      resourceType: "schedule",
      resourceId: id,
    });
    return c.body(null, 204);
  });

  // GET /api/schedules/:id/runs — list runs for a schedule
  router.get("/schedules/:id/runs", async (c) => {
    const scheduleId = c.req.param("id");
    const scope = getAppScope(c);
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
    const result = await listScheduleRuns(scope, scheduleId, {
      limit,
      offset,
    });
    setOffsetLinkHeader({ c, limit, offset, total: result.total });
    return c.json(result);
  });

  return router;
}
