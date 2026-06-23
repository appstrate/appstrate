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
import { getActor, type Actor } from "../lib/actor.ts";
import { getAppScope, type AppScope } from "../lib/scope.ts";
import { getOrgMember } from "../services/organizations.ts";
import { getEndUser } from "../services/end-users.ts";
import { assertExplicitModelExists } from "../services/org-models.ts";
import { asJSONSchemaObject, schemaHasFileFields } from "@appstrate/core/form";
import { listScheduleRuns } from "../services/state/runs.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import { setOffsetLinkHeader } from "../lib/pagination-link.ts";
import { listResponse } from "../lib/list-response.ts";
import { runConfigOverrideSchema, scheduleInputSchema } from "../lib/jsonb-schemas.ts";

// Per-integration connection picks frozen on the schedule row (cascade
// mechanism #3). Same wire shape as the run-route's connection_overrides;
// loses to admin pins at fire time. Shape: { "@scope/integration": "<connection_id>" }.
const connectionOverridesSchema = z.record(z.string(), z.string());

// Per-dependency version overrides frozen on the schedule row (#666/#686).
// Same wire shape as the run-route's dependency_overrides; keys may name a
// declared skill OR integration. Shape: { "@scope/dep": "draft" | "<spec>" }.
const dependencyOverridesSchema = z.record(z.string(), z.string());

// #738: schedule execution identity, chosen by an admin from the form.
// XOR — exactly one of user_id / end_user_id. Omitted at create → defaults to
// the caller (`getActor`). Omitted at update → actor left untouched. The actor
// can never be cleared (preserves #735: a schedule always has an identity).
const actorSchema = z
  .object({
    user_id: z.string().optional(),
    end_user_id: z.string().optional(),
  })
  .refine((a) => !(a.user_id && a.end_user_id), {
    message: "user_id and end_user_id are mutually exclusive",
  });

/**
 * Resolves + validates a selected schedule actor against the org/app scope.
 * Validates org membership (user) or app ownership (end-user) so a schedule
 * can never be pinned to an identity outside the caller's tenant. Returns
 * `fallback` when no actor was selected (the create-route default).
 */
async function resolveScheduleActor(
  scope: AppScope,
  selected: { user_id?: string; end_user_id?: string } | undefined,
  fallback?: Actor,
): Promise<Actor> {
  if (!selected || (!selected.user_id && !selected.end_user_id)) {
    if (fallback) return fallback;
    throw invalidRequest("actor.user_id or actor.end_user_id is required", "actor");
  }
  if (selected.user_id && selected.end_user_id) {
    throw invalidRequest("actor.user_id and actor.end_user_id are mutually exclusive", "actor");
  }
  if (selected.user_id) {
    const member = await getOrgMember(scope.orgId, selected.user_id);
    if (!member) {
      throw invalidRequest("actor.user_id is not a member of this organization", "actor.user_id");
    }
    return { type: "user", id: selected.user_id };
  }
  // end_user_id present — getEndUser throws notFound when absent in this app/org.
  await getEndUser(scope, selected.end_user_id!);
  return { type: "end_user", id: selected.end_user_id! };
}

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
  dependency_overrides: dependencyOverridesSchema.optional(),
  actor: actorSchema.optional(),
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
  dependency_overrides: dependencyOverridesSchema.nullable().optional(),
  // No `.nullable()` — the actor can be re-pointed but never cleared (#735).
  actor: actorSchema.optional(),
});

export function createSchedulesRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/schedules — list all schedules (app-scoped)
  router.get("/schedules", async (c) => {
    const scope = getAppScope(c);
    const schedules = await listSchedules(scope);
    return c.json(listResponse(schedules));
  });

  // GET /api/agents/:scope/:name/schedules — list schedules for an agent
  router.get("/agents/:scope{@[^/]+}/:name/schedules", requireAgent(), async (c) => {
    const scope = getAppScope(c);
    const agent = c.get("package");
    const schedules = await listPackageSchedules(scope, agent.id);
    return c.json(listResponse(schedules));
  });

  // POST /api/agents/:scope/:name/schedules — create a schedule
  router.post(
    "/agents/:scope{@[^/]+}/:name/schedules",
    rateLimit(10),
    requireAgent(),
    requirePermission("schedules", "write"),
    async (c) => {
      const agent = c.get("package");

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

      // #738: actor defaults to the caller; an admin may override it from the
      // form (validated against this org/app scope).
      const actor = await resolveScheduleActor(scope, data.actor, getActor(c));

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
        dependencyOverrides: data.dependency_overrides ?? null,
      });
      await recordAuditFromContext(c, {
        action: "schedule.created",
        resourceType: "schedule",
        resourceId: schedule.id,
        after: {
          packageId: agent.id,
          cronExpression: data.cron_expression,
          timezone: data.timezone,
          actorType: actor.type,
          actorId: actor.id,
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

    // #738: re-point the actor when the caller selected one (validated against
    // this org/app scope). `undefined` leaves the existing actor untouched.
    const actor =
      data.actor && (data.actor.user_id || data.actor.end_user_id)
        ? await resolveScheduleActor(scope, data.actor)
        : undefined;

    // When the actor changes, frozen `connection_overrides` would reference the
    // previous identity's connections. Reset them to null unless the same patch
    // supplies fresh picks, forcing a re-pick under the new identity.
    const connectionOverrides =
      actor && data.connection_overrides === undefined ? null : data.connection_overrides;

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
      connectionOverrides,
      dependencyOverrides: data.dependency_overrides,
      actor,
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
    if (data.dependency_overrides !== undefined)
      auditAfter.dependencyOverrides = data.dependency_overrides;
    if (actor) {
      auditAfter.actorType = actor.type;
      auditAfter.actorId = actor.id;
    }
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
      actor: getActor(c),
    });
    setOffsetLinkHeader({ c, limit, offset, total: result.total });
    return c.json(result);
  });

  return router;
}
