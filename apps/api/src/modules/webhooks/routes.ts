// SPDX-License-Identifier: Apache-2.0

/**
 * Webhooks API — CRUD + test ping + secret rotation + delivery history.
 *
 * Polymorphic across scoping level (mirrors the OIDC oauth_clients model):
 *   - `level: "org"`: fires for any application in the org
 *   - `level: "application"`: pinned to a single app via `applicationId`
 *
 * Routes are org-scoped — the body discriminates on `level` at create time.
 * `GET /api/webhooks?applicationId=` filters the list by pinned app.
 */

import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applications } from "@appstrate/db/schema";
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
import { parseBody, forbidden, invalidRequest } from "../../lib/errors.ts";
import { requirePermission } from "../../middleware/require-permission.ts";

/**
 * Assert that an application belongs to the given org.
 * Throws `forbidden` if the app doesn't exist or belongs to another org.
 */
async function assertAppBelongsToOrg(applicationId: string, orgId: string): Promise<void> {
  const [app] = await db
    .select({ orgId: applications.orgId })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (!app || app.orgId !== orgId) {
    throw forbidden("applicationId must belong to the current organization");
  }
}

const createOrgWebhookSchema = z.object({
  level: z.literal("org"),
  url: z.url("url must be a valid URL"),
  events: z.array(webhookEventSchema).min(1, "events is required"),
  packageId: z.string().nullable().optional(),
  payloadMode: z.enum(["full", "summary"]).optional(),
  enabled: z.boolean().optional(),
});

const createApplicationWebhookSchema = z.object({
  level: z.literal("application"),
  applicationId: z.string().startsWith("app_", "applicationId must start with 'app_' prefix"),
  url: z.url("url must be a valid URL"),
  events: z.array(webhookEventSchema).min(1, "events is required"),
  packageId: z.string().nullable().optional(),
  payloadMode: z.enum(["full", "summary"]).optional(),
  enabled: z.boolean().optional(),
});

export const createWebhookSchema = z.discriminatedUnion("level", [
  createOrgWebhookSchema,
  createApplicationWebhookSchema,
]);

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
      const body = await c.req.json();
      const data = parseBody(createWebhookSchema, body);

      if (data.level === "application") {
        await assertAppBelongsToOrg(data.applicationId, orgId);
      }

      const result = await createWebhook(
        data.level === "org"
          ? {
              level: "org",
              orgId,
              url: data.url,
              events: data.events,
              packageId: data.packageId,
              payloadMode: data.payloadMode,
              enabled: data.enabled,
            }
          : {
              level: "application",
              orgId,
              applicationId: data.applicationId,
              url: data.url,
              events: data.events,
              packageId: data.packageId,
              payloadMode: data.payloadMode,
              enabled: data.enabled,
            },
      );
      return c.json(result, 201);
    },
  );

  // GET /api/webhooks[?applicationId=...&all=true] — list webhooks visible to the caller
  router.get("/api/webhooks", rateLimit(300), requirePermission("webhooks", "read"), async (c) => {
    const orgId = c.get("orgId");
    const all = c.req.query("all") === "true";
    const applicationId = c.req.query("applicationId") || undefined;
    if (applicationId) {
      if (!applicationId.startsWith("app_")) {
        throw invalidRequest("applicationId must start with 'app_' prefix", "applicationId");
      }
      await assertAppBelongsToOrg(applicationId, orgId);
    }
    const result = await listWebhooks(orgId, { applicationId, all });
    return c.json({ object: "list", data: result });
  });

  // GET /api/webhooks/:id — get webhook detail
  router.get(
    "/api/webhooks/:id",
    rateLimit(300),
    requirePermission("webhooks", "read"),
    async (c) => {
      const orgId = c.get("orgId");
      const result = await getWebhook(orgId, c.req.param("id")!);
      return c.json(result);
    },
  );

  // PUT /api/webhooks/:id — update webhook (url, events, filters — not secret/level)
  router.put(
    "/api/webhooks/:id",
    rateLimit(10),
    requirePermission("webhooks", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const body = await c.req.json();
      const data = parseBody(updateWebhookSchema, body);

      const result = await updateWebhook(orgId, c.req.param("id")!, data);
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
      await deleteWebhook(orgId, c.req.param("id")!);
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
      const webhookId = c.req.param("id")!;
      const wh = await getWebhook(orgId, webhookId);

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
      const result = await rotateSecret(orgId, c.req.param("id")!);
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
      const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 20;
      const result = await listDeliveries(orgId, c.req.param("id")!, limit);
      return c.json({ object: "list", data: result });
    },
  );

  return router;
}
