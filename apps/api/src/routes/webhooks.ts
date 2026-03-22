/**
 * Webhooks API — CRUD + test ping + secret rotation + delivery history.
 * All routes require API key auth (admin).
 */

import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { requireAdmin } from "../middleware/guards.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
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
import { invalidRequest } from "../lib/errors.ts";

export function createWebhooksRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/webhooks — create a webhook (returns secret once)
  router.post("/", rateLimit(10), requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json<{
      url: string;
      events: string[];
      flowId?: string | null;
      payloadMode?: string;
      active?: boolean;
    }>();

    if (!body.url) throw invalidRequest("url is required", "url");
    if (!body.events) throw invalidRequest("events is required", "events");

    const result = await createWebhook(orgId, body);
    return c.json(result, 201);
  });

  // GET /api/webhooks — list webhooks
  router.get("/", rateLimit(300), requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const result = await listWebhooks(orgId);
    return c.json({ object: "list", data: result });
  });

  // GET /api/webhooks/:id — get webhook detail
  router.get("/:id", rateLimit(300), requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const result = await getWebhook(orgId, c.req.param("id")!);
    return c.json(result);
  });

  // PUT /api/webhooks/:id — update webhook (url, events, filters — not secret)
  router.put("/:id", rateLimit(10), requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json<{
      url?: string;
      events?: string[];
      flowId?: string | null;
      payloadMode?: string;
      active?: boolean;
    }>();

    const result = await updateWebhook(orgId, c.req.param("id")!, body);
    return c.json(result);
  });

  // DELETE /api/webhooks/:id — delete webhook
  router.delete("/:id", rateLimit(10), requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    await deleteWebhook(orgId, c.req.param("id")!);
    return c.body(null, 204);
  });

  // POST /api/webhooks/:id/test — send a synthetic test.ping event
  router.post("/:id/test", rateLimit(5), requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const webhookId = c.req.param("id")!;
    const wh = await getWebhook(orgId, webhookId);

    const { eventId, payload } = buildEventEnvelope({
      eventType: "test.ping",
      execution: { id: "exec_test", flowId: "test", status: "success" },
      payloadMode: wh.payloadMode as "full" | "summary",
    });

    return c.json({ eventId, payload });
  });

  // POST /api/webhooks/:id/rotate — rotate secret (24h grace period)
  router.post("/:id/rotate", rateLimit(5), requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const result = await rotateSecret(orgId, c.req.param("id")!);
    return c.json(result);
  });

  // GET /api/webhooks/:id/deliveries — delivery history
  router.get("/:id/deliveries", rateLimit(300), requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 20;
    const result = await listDeliveries(orgId, c.req.param("id")!, limit);
    return c.json({ object: "list", data: result });
  });

  return router;
}
