// SPDX-License-Identifier: Apache-2.0

/**
 * Webhooks API — CRUD + test ping + secret rotation + delivery history.
 *
 * Polymorphic across scoping level (mirrors the OIDC oauth_clients model):
 *   - `level: "org"`: fires for any space in the org
 *   - `level: "space"`: pinned to a single space via `spaceId`
 *
 * Routes are org-scoped — the body discriminates on `level` at create time.
 * `GET /api/webhooks?spaceId=` filters the list by pinned space.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../types/index.ts";
import { rateLimit } from "../../middleware/rate-limit.ts";
import { idempotency } from "../../middleware/idempotency.ts";
import { listResponse } from "../../lib/list-response.ts";
import { recordAuditFromContext } from "../../services/audit.ts";
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
import { forbidden } from "../../lib/errors.ts";
import { readJsonBody } from "../../lib/request-body.ts";
import { requireModulePermission } from "@appstrate/core/permissions";
import { getOrgScope, type SpaceScope, type OrgScope } from "../../lib/scope.ts";
import { assertSpaceId } from "../../lib/ids.ts";
import { validateSpaceInOrg } from "../../middleware/space-context.ts";
import { parseListPagination } from "../../lib/list-query.ts";

/**
 * Assert that a space belongs to the given org.
 * Throws `forbidden` if the space does not exist or belongs to another org.
 *
 * Delegates to the canonical `validateSpaceInOrg` — same SELECT, plus the
 * `assertSpaceId` shape guard this copy did not have. Both call sites already
 * assert the shape with a `spaceId` param name, so that guard is a backstop
 * here rather than the primary diagnostic.
 */
async function assertSpaceBelongsToOrg(spaceId: string, orgId: string): Promise<void> {
  if (!(await validateSpaceInOrg(spaceId, orgId))) {
    throw forbidden("spaceId must belong to the current organization");
  }
}

const createOrgWebhookSchema = z
  .object({
    level: z.literal("org"),
    url: z.url("url must be a valid URL"),
    events: z.array(webhookEventSchema).min(1, "events is required"),
    packageId: z.string().nullable().optional(),
    payloadMode: z.enum(["full", "summary"]).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const createSpaceWebhookSchema = z
  .object({
    level: z.literal("space"),
    // Shape deliberately NOT re-encoded here: `assertSpaceId` (called by the
    // handler right after parse) is the single implementation of the space-id
    // shape check AND of its two diagnostics — a retired `app_` id must say "run
    // the `app_` → `spc_` migration" on this route exactly as it does on
    // `X-Space-Id`. A `.regex()` here would win the race and answer with a
    // generic message instead.
    spaceId: z.string(),
    url: z.url("url must be a valid URL"),
    events: z.array(webhookEventSchema).min(1, "events is required"),
    packageId: z.string().nullable().optional(),
    payloadMode: z.enum(["full", "summary"]).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const createWebhookSchema = z.discriminatedUnion("level", [
  createOrgWebhookSchema,
  createSpaceWebhookSchema,
]);

export const updateWebhookSchema = z
  .object({
    url: z.url().optional(),
    events: z.array(webhookEventSchema).min(1).optional(),
    packageId: z.string().nullable().optional(),
    payloadMode: z.enum(["full", "summary"]).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/** Optional body of `POST /api/webhooks/{id}/rotate`. */
export const rotateSecretSchema = z
  .object({
    windowSeconds: z.number().int().positive().optional(),
  })
  .strict();

export function createWebhooksRouter() {
  const router = new Hono<AppEnv>();

  // Issue #172 (extension) — webhooks are space-scoped (or org-level
  // and span every space). API keys must never reach a webhook outside their
  // bound space, so we narrow their scope to `SpaceScope`; sessions
  // keep `OrgScope` (full org reach) and decide filtering via query params.
  // Building the scope here (rather than passing two strings) is what makes
  // it impossible at the type level to forget the space-scoping downstream.
  function webhookScope(c: Context<AppEnv>): OrgScope | SpaceScope {
    if (c.get("authMethod") === "api_key") {
      return { orgId: c.get("orgId"), spaceId: c.get("spaceId") };
    }
    return getOrgScope(c);
  }

  // POST /api/webhooks — create a webhook (returns secret once)
  router.post(
    "/api/webhooks",
    rateLimit(10),
    idempotency(),
    requireModulePermission("webhooks", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const data = await readJsonBody(c, createWebhookSchema);

      if (data.level === "space") {
        assertSpaceId(data.spaceId, "spaceId");
      }

      // API keys cannot create org-level webhooks (would span foreign spaces)
      // and cannot create space-level webhooks targeting another space.
      const isApiKey = c.get("authMethod") === "api_key";
      if (isApiKey) {
        if (data.level !== "space") {
          throw forbidden("API keys cannot create org-level webhooks");
        }
        if (data.spaceId !== c.get("spaceId")) {
          throw forbidden("API key scope does not include this space");
        }
      }

      if (data.level === "space") {
        await assertSpaceBelongsToOrg(data.spaceId, orgId);
      }

      const result = await createWebhook(
        data.level === "org"
          ? {
              level: "org",
              scope: { orgId },
              url: data.url,
              events: data.events,
              packageId: data.packageId,
              payloadMode: data.payloadMode,
              enabled: data.enabled,
            }
          : {
              level: "space",
              scope: { orgId, spaceId: data.spaceId },
              url: data.url,
              events: data.events,
              packageId: data.packageId,
              payloadMode: data.payloadMode,
              enabled: data.enabled,
            },
      );
      await recordAuditFromContext(c, {
        action: "webhook.created",
        resourceType: "webhook",
        resourceId: result.id,
        after: { url: data.url, events: data.events, level: data.level },
      });
      return c.json(result, 201);
    },
  );

  // GET /api/webhooks[?spaceId=...&all=true] — list webhooks visible to the caller
  router.get(
    "/api/webhooks",
    rateLimit(300),
    requireModulePermission("webhooks", "read"),
    async (c) => {
      const scope = webhookScope(c);

      // SpaceScope callers (API keys) are fully narrowed inside listWebhooks —
      // it ignores `opts` and returns only webhooks pinned to the key's space.
      if ("spaceId" in scope) {
        const result = await listWebhooks(scope);
        return c.json(listResponse(result));
      }

      const all = c.req.query("all") === "true";
      const spaceId = c.req.query("spaceId") || undefined;
      if (spaceId) {
        assertSpaceId(spaceId, "spaceId");
        await assertSpaceBelongsToOrg(spaceId, scope.orgId);
      }
      const result = await listWebhooks(scope, { spaceId, all });
      return c.json(listResponse(result));
    },
  );

  // GET /api/webhooks/:id — get webhook detail
  router.get(
    "/api/webhooks/:id",
    rateLimit(300),
    requireModulePermission("webhooks", "read"),
    async (c) => {
      const result = await getWebhook(webhookScope(c), c.req.param("id")!);
      return c.json(result);
    },
  );

  // PUT /api/webhooks/:id — update webhook (url, events, filters — not secret/level)
  router.put(
    "/api/webhooks/:id",
    rateLimit(10),
    requireModulePermission("webhooks", "write"),
    async (c) => {
      const data = await readJsonBody(c, updateWebhookSchema);

      const result = await updateWebhook(webhookScope(c), c.req.param("id")!, data);
      await recordAuditFromContext(c, {
        action: "webhook.updated",
        resourceType: "webhook",
        resourceId: c.req.param("id")!,
        after: data as unknown as Record<string, unknown>,
      });
      return c.json(result);
    },
  );

  // DELETE /api/webhooks/:id — delete webhook
  router.delete(
    "/api/webhooks/:id",
    rateLimit(10),
    requireModulePermission("webhooks", "delete"),
    async (c) => {
      const id = c.req.param("id")!;
      await deleteWebhook(webhookScope(c), id);
      await recordAuditFromContext(c, {
        action: "webhook.deleted",
        resourceType: "webhook",
        resourceId: id,
      });
      return c.body(null, 204);
    },
  );

  // POST /api/webhooks/:id/test — send a synthetic test.ping event
  router.post(
    "/api/webhooks/:id/test",
    rateLimit(5),
    requireModulePermission("webhooks", "write"),
    async (c) => {
      const webhookId = c.req.param("id")!;
      const wh = await getWebhook(webhookScope(c), webhookId);

      const { eventId, payload } = buildEventEnvelope({
        eventType: "test.ping",
        run: { id: "run_test", packageId: "test", status: "success" },
        payloadMode:
          wh.payloadMode === "full" || wh.payloadMode === "summary" ? wh.payloadMode : "full",
      });

      return c.json({ eventId, payload });
    },
  );

  // POST /api/webhooks/:id/rotate — open a dual-signature rotation window.
  // Body is optional: `{ windowSeconds?: number }` overrides the default
  // 7-day window (capped at 30 days). The response carries both the new
  // secret (for consumer migration) and the previous one (still valid
  // until the window closes), plus the deadline.
  router.post(
    "/api/webhooks/:id/rotate",
    rateLimit(5),
    requireModulePermission("webhooks", "write"),
    async (c) => {
      const id = c.req.param("id")!;
      const parsed = await readJsonBody(c, rotateSecretSchema, { allowEmpty: true });
      const result = await rotateSecret(webhookScope(c), id, parsed);
      await recordAuditFromContext(c, {
        action: "webhook.secret_rotated",
        resourceType: "webhook",
        resourceId: id,
        after: { rotationWindowEndsAt: result.rotationWindowEndsAt },
      });
      return c.json(result);
    },
  );

  // GET /api/webhooks/:id/deliveries — delivery history
  router.get(
    "/api/webhooks/:id/deliveries",
    rateLimit(300),
    requireModulePermission("webhooks", "read"),
    async (c) => {
      // Coerce + bound the limit: a raw `Number("-5")`/`Number("x")` (NaN)
      // would otherwise reach the query and 500. Out-of-range / unparseable
      // falls back to 20 — `parseListPagination` owns that idiom.
      const { limit } = parseListPagination(c, { defaultLimit: 20 });
      const result = await listDeliveries(webhookScope(c), c.req.param("id")!, limit);
      return c.json(listResponse(result));
    },
  );

  return router;
}
