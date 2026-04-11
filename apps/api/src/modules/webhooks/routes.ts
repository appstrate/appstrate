// SPDX-License-Identifier: Apache-2.0

/**
 * Webhooks API — CRUD + test ping + secret rotation + delivery history.
 *
 * All webhooks are application-scoped. The application context comes from
 * the X-App-Id header (resolved by app-context middleware).
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../types/index.ts";
import { rateLimit } from "../../middleware/rate-limit.ts";
import { idempotency } from "../../middleware/idempotency.ts";
import {
  createWebhook,
  listWebhooks,
  getWebhook,
  updateWebhook,
  deleteWebhook,
  rotateSecret,
  listDeliveries,
  buildEventEnvelope,
  webhookEventSchema,
} from "./service.ts";
import { parseBody } from "../../lib/errors.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
export const createWebhookSchema = z.object({
  url: z.url("url must be a valid URL"),
  events: z.array(webhookEventSchema).min(1, "events is required"),
  packageId: z.string().nullable().optional(),
  payloadMode: z.enum(["full", "summary"]).optional(),
  enabled: z.boolean().optional(),
});

export const updateWebhookSchema = z.object({
  url: z.url().optional(),
  events: z.array(webhookEventSchema).min(1).optional(),
  packageId: z.string().nullable().optional(),
  payloadMode: z.enum(["full", "summary"]).optional(),
  enabled: z.boolean().optional(),
});

export function createWebhooksRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/webhooks — create a webhook (returns secret once)
  router.post(
    "/api/webhooks",
    rateLimit(10),
    idempotency(),
    requirePermission("webhooks", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const applicationId = c.get("applicationId");
      const body = await c.req.json();
      const data = parseBody(createWebhookSchema, body);

      const result = await createWebhook(orgId, applicationId, {
        url: data.url,
        events: data.events,
        packageId: data.packageId,
        payloadMode: data.payloadMode,
        enabled: data.enabled,
      });
      return c.json(result, 201);
    },
  );

  // GET /api/webhooks — list webhooks for the current application
  router.get("/api/webhooks", rateLimit(300), requirePermission("webhooks", "read"), async (c) => {
    const orgId = c.get("orgId");
    const applicationId = c.get("applicationId");
    const result = await listWebhooks(orgId, applicationId);
    return c.json({ object: "list", data: result });
  });

  // GET /api/webhooks/:id — get webhook detail
  router.get(
    "/api/webhooks/:id",
    rateLimit(300),
    requirePermission("webhooks", "read"),
    async (c) => {
      const orgId = c.get("orgId");
      const applicationId = c.get("applicationId");
      const result = await getWebhook(orgId, applicationId, c.req.param("id")!);
      return c.json(result);
    },
  );

  // PUT /api/webhooks/:id — update webhook (url, events, filters — not secret)
  router.put(
    "/api/webhooks/:id",
    rateLimit(10),
    requirePermission("webhooks", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const applicationId = c.get("applicationId");
      const body = await c.req.json();
      const data = parseBody(updateWebhookSchema, body);

      const result = await updateWebhook(orgId, applicationId, c.req.param("id")!, data);
      return c.json(result);
    },
  );

  // DELETE /api/webhooks/:id — delete webhook
  router.delete(
    "/api/webhooks/:id",
    rateLimit(10),
    requirePermission("webhooks", "delete"),
    async (c) => {
      const orgId = c.get("orgId");
      const applicationId = c.get("applicationId");
      await deleteWebhook(orgId, applicationId, c.req.param("id")!);
      return c.body(null, 204);
    },
  );

  // POST /api/webhooks/:id/test — send a synthetic test.ping event
  router.post(
    "/api/webhooks/:id/test",
    rateLimit(5),
    requirePermission("webhooks", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const applicationId = c.get("applicationId");
      const webhookId = c.req.param("id")!;
      const wh = await getWebhook(orgId, applicationId, webhookId);

      const { eventId, payload } = buildEventEnvelope({
        eventType: "test.ping",
        run: { id: "exec_test", packageId: "test", status: "success" },
        payloadMode:
          wh.payloadMode === "full" || wh.payloadMode === "summary" ? wh.payloadMode : "full",
      });

      return c.json({ eventId, payload });
    },
  );

  // POST /api/webhooks/:id/rotate — rotate secret (24h grace period)
  router.post(
    "/api/webhooks/:id/rotate",
    rateLimit(5),
    requirePermission("webhooks", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const applicationId = c.get("applicationId");
      const result = await rotateSecret(orgId, applicationId, c.req.param("id")!);
      return c.json(result);
    },
  );

  // GET /api/webhooks/:id/deliveries — delivery history
  router.get(
    "/api/webhooks/:id/deliveries",
    rateLimit(300),
    requirePermission("webhooks", "read"),
    async (c) => {
      const orgId = c.get("orgId");
      const applicationId = c.get("applicationId");
      const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 20;
      const result = await listDeliveries(orgId, applicationId, c.req.param("id")!, limit);
      return c.json({ object: "list", data: result });
    },
  );

  return router;
}
