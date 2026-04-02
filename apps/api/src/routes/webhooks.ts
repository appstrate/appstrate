// SPDX-License-Identifier: Apache-2.0

/**
 * Webhooks API — CRUD + test ping + secret rotation + delivery history.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { idempotency } from "../middleware/idempotency.ts";
import {
  createWebhook,
  listWebhooks,
  getWebhook,
  updateWebhook,
  deleteWebhook,
  rotateSecret,
  listDeliveries,
  buildEventEnvelope,
} from "../services/webhooks.ts";
import { parseBody } from "../lib/errors.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { getApplication } from "../services/applications.ts";

const webhookEventsEnum = z.enum([
  "run.started",
  "run.completed",
  "run.failed",
  "run.timeout",
  "run.cancelled",
]);

const webhookScopeEnum = z.enum(["organization", "application"]);

const createWebhookSchema = z
  .object({
    scope: webhookScopeEnum.optional().default("application"),
    applicationId: z.string().min(1).optional(),
    url: z.url("url must be a valid URL"),
    events: z.array(webhookEventsEnum).min(1, "events is required"),
    packageId: z.string().nullable().optional(),
    payloadMode: z.enum(["full", "summary"]).optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (data) => data.scope !== "application" || (data.applicationId && data.applicationId.length > 0),
    { message: "applicationId is required when scope is 'application'", path: ["applicationId"] },
  );

const updateWebhookSchema = z.object({
  url: z.url().optional(),
  events: z.array(webhookEventsEnum).min(1).optional(),
  packageId: z.string().nullable().optional(),
  payloadMode: z.enum(["full", "summary"]).optional(),
  active: z.boolean().optional(),
});

export function createWebhooksRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/webhooks — create a webhook (returns secret once)
  router.post(
    "/",
    rateLimit(10),
    idempotency(),
    requirePermission("webhooks", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const body = await c.req.json();
      const data = parseBody(createWebhookSchema, body);

      // Verify applicationId belongs to this org when scope is "application"
      if (data.scope === "application" && data.applicationId) {
        await getApplication(orgId, data.applicationId);
      }

      const result = await createWebhook(orgId, {
        scope: data.scope,
        applicationId: data.applicationId,
        url: data.url,
        events: data.events,
        packageId: data.packageId,
        payloadMode: data.payloadMode,
        active: data.active,
      });
      return c.json(result, 201);
    },
  );

  // GET /api/webhooks — list webhooks (optionally filtered by scope/applicationId)
  router.get("/", rateLimit(300), requirePermission("webhooks", "read"), async (c) => {
    const orgId = c.get("orgId");
    const applicationId = c.req.query("applicationId");
    const scope = c.req.query("scope");
    const result = await listWebhooks(orgId, { applicationId, scope });
    return c.json({ object: "list", data: result });
  });

  // GET /api/webhooks/:id — get webhook detail
  router.get("/:id", rateLimit(300), requirePermission("webhooks", "read"), async (c) => {
    const orgId = c.get("orgId");
    const result = await getWebhook(orgId, c.req.param("id")!);
    return c.json(result);
  });

  // PUT /api/webhooks/:id — update webhook (url, events, filters — not secret)
  router.put("/:id", rateLimit(10), requirePermission("webhooks", "write"), async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const data = parseBody(updateWebhookSchema, body);

    const result = await updateWebhook(orgId, c.req.param("id")!, data);
    return c.json(result);
  });

  // DELETE /api/webhooks/:id — delete webhook
  router.delete("/:id", rateLimit(10), requirePermission("webhooks", "delete"), async (c) => {
    const orgId = c.get("orgId");
    await deleteWebhook(orgId, c.req.param("id")!);
    return c.body(null, 204);
  });

  // POST /api/webhooks/:id/test — send a synthetic test.ping event
  router.post("/:id/test", rateLimit(5), requirePermission("webhooks", "write"), async (c) => {
    const orgId = c.get("orgId");
    const webhookId = c.req.param("id")!;
    const wh = await getWebhook(orgId, webhookId);

    const { eventId, payload } = buildEventEnvelope({
      eventType: "test.ping",
      execution: { id: "exec_test", packageId: "test", status: "success" },
      payloadMode:
        wh.payloadMode === "full" || wh.payloadMode === "summary" ? wh.payloadMode : "full",
    });

    return c.json({ eventId, payload });
  });

  // POST /api/webhooks/:id/rotate — rotate secret (24h grace period)
  router.post("/:id/rotate", rateLimit(5), requirePermission("webhooks", "write"), async (c) => {
    const orgId = c.get("orgId");
    const result = await rotateSecret(orgId, c.req.param("id")!);
    return c.json(result);
  });

  // GET /api/webhooks/:id/deliveries — delivery history
  router.get(
    "/:id/deliveries",
    rateLimit(300),
    requirePermission("webhooks", "read"),
    async (c) => {
      const orgId = c.get("orgId");
      const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 20;
      const result = await listDeliveries(orgId, c.req.param("id")!, limit);
      return c.json({ object: "list", data: result });
    },
  );

  return router;
}
