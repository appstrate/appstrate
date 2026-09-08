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
import { requireAnyPermission } from "../../middleware/require-permission.ts";
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
import type { WebhookInfo } from "@appstrate/shared-types";
import { ApiError, forbidden } from "../../lib/errors.ts";
import { readJsonBody } from "@appstrate/core/request-body";
import { enterSpaceContext, makePermissionGuard } from "@appstrate/core/permissions";
import { getOrgScope, type SpaceScope, type OrgScope } from "../../lib/scope.ts";
import { assertSpaceId } from "../../lib/ids.ts";
import { validateSpaceInOrg } from "../../lib/space-lookup.ts";
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

function webhookResource(level: string): "webhooks" | "org-webhooks" {
  return level === "org" ? "org-webhooks" : "webhooks";
}

/** In-handler guard (the level is known only from the body or row); same audit + 403 shape. */
async function assertWebhookPermission(
  c: Context<AppEnv>,
  level: string,
  action: "read" | "write" | "delete",
): Promise<void> {
  await makePermissionGuard(`${webhookResource(level)}:${action}`)(c, async () => undefined);
}

/** A route admitting either level gates on both, so the denial audit names both. */
const ANY_WEBHOOK_READ = ["webhooks:read", "org-webhooks:read"];
const ANY_WEBHOOK_WRITE = ["webhooks:write", "org-webhooks:write"];

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

  // `/api/webhooks` is deliberately NOT in `SPACE_SCOPED_PREFIXES`, so the router
  // enters the caller's space itself — org permissions carry no `webhooks:*`
  // string (RBAC spec §4.3). Conditional because `enterSpaceContext` 400s a
  // caller naming no space and `level: "org"` webhooks are space-less: the org
  // half is then exactly what org-level routes need. Other routes re-enter their own.
  const enterCallerSpace = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    if (c.get("spaceId") ?? c.req.header("X-Space-Id")) await enterSpaceContext(c);
    return next();
  };
  // `/x/*` matches `/x` too, so this covers the collection and every by-id route.
  router.use("/api/webhooks/*", enterCallerSpace);

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
  router.post("/api/webhooks", rateLimit(10), idempotency(), async (c) => {
    const orgId = c.get("orgId");
    const data = await readJsonBody(c, createWebhookSchema);

    // The BODY's space decides the permission. A caller with no webhook authority
    // anywhere gets one 403 for every failure, so the route is not a space oracle.
    if (data.level === "space") {
      assertSpaceId(data.spaceId, "spaceId");
      try {
        await assertSpaceBelongsToOrg(data.spaceId, orgId);
        await enterSpaceContext(c, data.spaceId);
      } catch (err) {
        await requireAnyPermission(ANY_WEBHOOK_WRITE)(c, async () => {});
        throw err;
      }
    }
    await assertWebhookPermission(c, data.level, "write");

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
  });

  // GET /api/webhooks[?spaceId=...&all=true] — list webhooks visible to the caller
  router.get("/api/webhooks", rateLimit(300), requireAnyPermission(ANY_WEBHOOK_READ), async (c) => {
    const scope = webhookScope(c);

    // The page spans BOTH levels: drop rows whose level the caller cannot read.
    // `permissions` is read at call time — entering a space below rewrites it.
    const readable = (rows: WebhookInfo[]): WebhookInfo[] => {
      const permissions = c.get("permissions") ?? new Set<string>();
      return rows.filter((w) => permissions.has(`${webhookResource(w.level)}:read`));
    };

    // SpaceScope callers (API keys) are fully narrowed inside listWebhooks —
    // it ignores `opts` and returns only webhooks pinned to the key's space.
    if ("spaceId" in scope) {
      return c.json(listResponse(readable(await listWebhooks(scope))));
    }

    const all = c.req.query("all") === "true";
    const spaceId = c.req.query("spaceId") || undefined;
    if (spaceId) {
      assertSpaceId(spaceId, "spaceId");
      await assertSpaceBelongsToOrg(spaceId, scope.orgId);
      // The filter may name a DIFFERENT space than the router entered; its permission rules.
      await enterSpaceContext(c, spaceId);
      await assertWebhookPermission(c, "space", "read");
    }
    if (all) {
      // `all=true` spans EVERY space; `readable` checks level, not space, so
      // only the org-level permission may authorise a cross-space view.
      await assertWebhookPermission(c, "org", "read");
    }
    return c.json(listResponse(readable(await listWebhooks(scope, { spaceId, all }))));
  });

  /** Load the by-id row, then gate on its level. Without any webhook permission, a miss is 403. */
  async function loadWebhookForAction(
    c: Context<AppEnv>,
    action: "read" | "write" | "delete",
  ): Promise<WebhookInfo> {
    let webhook: WebhookInfo;
    try {
      webhook = await getWebhook(webhookScope(c), c.req.param("id")!);
    } catch (err) {
      // ONLY the 404 is convertible; laundering a DB failure into 403 would hide an outage.
      if (!(err instanceof ApiError && err.status === 404)) throw err;
      await requireAnyPermission(ANY_WEBHOOK_READ)(c, async () => {});
      throw err;
    }
    // The row's own space decides the permission; it need not be the one entered above.
    if (webhook.level === "space" && webhook.spaceId) {
      await enterSpaceContext(c, webhook.spaceId);
    }
    await assertWebhookPermission(c, webhook.level, action);
    return webhook;
  }

  // GET /api/webhooks/:id — get webhook detail
  router.get("/api/webhooks/:id", rateLimit(300), async (c) => {
    return c.json(await loadWebhookForAction(c, "read"));
  });

  // PUT /api/webhooks/:id — update webhook (url, events, filters — not secret/level)
  router.put("/api/webhooks/:id", rateLimit(10), async (c) => {
    // Permission check must still precede reading the body.
    await loadWebhookForAction(c, "write");
    const data = await readJsonBody(c, updateWebhookSchema);

    const result = await updateWebhook(webhookScope(c), c.req.param("id")!, data);
    await recordAuditFromContext(c, {
      action: "webhook.updated",
      resourceType: "webhook",
      resourceId: c.req.param("id")!,
      after: data as unknown as Record<string, unknown>,
    });
    return c.json(result);
  });

  // DELETE /api/webhooks/:id — delete webhook
  router.delete("/api/webhooks/:id", rateLimit(10), async (c) => {
    const id = c.req.param("id")!;
    await loadWebhookForAction(c, "delete");
    await deleteWebhook(webhookScope(c), id);
    await recordAuditFromContext(c, {
      action: "webhook.deleted",
      resourceType: "webhook",
      resourceId: id,
    });
    return c.body(null, 204);
  });

  // POST /api/webhooks/:id/test — send a synthetic test.ping event
  router.post("/api/webhooks/:id/test", rateLimit(5), async (c) => {
    const wh = await loadWebhookForAction(c, "write");

    const { eventId, payload } = buildEventEnvelope({
      eventType: "test.ping",
      run: { id: "run_test", packageId: "test", status: "success" },
      payloadMode:
        wh.payloadMode === "full" || wh.payloadMode === "summary" ? wh.payloadMode : "full",
    });

    return c.json({ eventId, payload });
  });

  // POST /api/webhooks/:id/rotate — open a dual-signature rotation window.
  // Body is optional: `{ windowSeconds?: number }` overrides the default
  // 7-day window (capped at 30 days). The response carries both the new
  // secret (for consumer migration) and the previous one (still valid
  // until the window closes), plus the deadline.
  router.post("/api/webhooks/:id/rotate", rateLimit(5), async (c) => {
    const id = c.req.param("id")!;
    await loadWebhookForAction(c, "write");
    const parsed = await readJsonBody(c, rotateSecretSchema, { allowEmpty: true });
    const result = await rotateSecret(webhookScope(c), id, parsed);
    await recordAuditFromContext(c, {
      action: "webhook.secret_rotated",
      resourceType: "webhook",
      resourceId: id,
      after: { rotationWindowEndsAt: result.rotationWindowEndsAt },
    });
    return c.json(result);
  });

  // GET /api/webhooks/:id/deliveries — delivery history
  router.get("/api/webhooks/:id/deliveries", rateLimit(300), async (c) => {
    await loadWebhookForAction(c, "read");
    // Coerce + bound the limit: a raw `Number("-5")`/`Number("x")` (NaN)
    // would otherwise reach the query and 500. Out-of-range / unparseable
    // falls back to 20 — `parseListPagination` owns that idiom.
    const { limit } = parseListPagination(c, { defaultLimit: 20 });
    const result = await listDeliveries(webhookScope(c), c.req.param("id")!, limit);
    return c.json(listResponse(result));
  });

  return router;
}
