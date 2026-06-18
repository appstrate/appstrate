// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { listResponse } from "../lib/list-response.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { isSystemProxy } from "../services/proxy-registry.ts";
import {
  listOrgProxies,
  getOrgProxy,
  createOrgProxy,
  updateOrgProxy,
  deleteOrgProxy,
  setDefaultProxy,
  testProxyConnection,
} from "../services/org-proxies.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../lib/logger.ts";
import {
  ApiError,
  notFound,
  internalError,
  parseBody,
  systemEntityForbidden,
} from "../lib/errors.ts";
import { recordAuditFromContext } from "../services/audit.ts";

export const createProxySchema = z.object({
  label: z.string().min(1, "label is required"),
  url: z.url({ error: "url must be a valid URL" }),
});

export const updateProxySchema = z.object({
  label: z.string().min(1).optional(),
  url: z.url().optional(),
  enabled: z.boolean().optional(),
});

export const setDefaultSchema = z.object({
  proxyId: z.string().nullable(),
});

export function createProxiesRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/proxies — list all proxies (system + DB)
  router.get("/", async (c) => {
    const orgId = c.get("orgId");
    const proxies = await listOrgProxies(orgId);
    return c.json(listResponse(proxies));
  });

  // POST /api/proxies — create a custom proxy
  router.post("/", requirePermission("proxies", "write"), async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const body = await c.req.json();
    const data = parseBody(createProxySchema, body);

    try {
      const id = await createOrgProxy(orgId, data.label, data.url, user.id);
      await recordAuditFromContext(c, {
        action: "proxy.created",
        resourceType: "proxy",
        resourceId: id,
        after: { label: data.label, url: data.url },
      });
      // Return the bare created resource — same shape as the GET list
      // serializer — so callers don't need a follow-up GET (#657).
      const proxy = await getOrgProxy(orgId, id);
      if (!proxy) throw internalError();
      return c.json(proxy, 201);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const msg = getErrorMessage(err);
      if (msg.includes("blocked network")) {
        throw new ApiError({ status: 400, code: "blocked_url", title: "Bad Request", detail: msg });
      }
      logger.error("Proxy create failed", { error: msg });
      throw internalError();
    }
  });

  // PUT /api/proxies/default — set the org default proxy
  // MUST be registered before PUT /:id
  router.put("/default", requirePermission("proxies", "write"), async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const data = parseBody(setDefaultSchema, body);

    try {
      await setDefaultProxy(orgId, data.proxyId);
      await recordAuditFromContext(c, {
        action: "proxy.default_set",
        resourceType: "proxy",
        resourceId: data.proxyId,
      });
      // Return the bare *effective* default proxy resource — recomputed from
      // the list serializer (DB flag, or the system-default fallback when no
      // DB row is flagged) — so callers see the resulting state without a
      // follow-up GET (#657). When no default remains in effect (unset with
      // no system fallback) there is no resource: 204.
      const proxies = await listOrgProxies(orgId);
      const def = proxies.find((p) => p.isDefault);
      return def ? c.json(def) : c.body(null, 204);
    } catch (err) {
      // A deliberate client error (e.g. unknown proxy ref → 404) must surface as
      // itself, not be masked as a 500 by the catch-all.
      if (err instanceof ApiError) throw err;
      logger.error("Set default proxy failed", {
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // POST /api/proxies/:id/test — test proxy connection
  router.post("/:id/test", rateLimit(5), async (c) => {
    const orgId = c.get("orgId");
    const proxyId = c.req.param("id")!;
    try {
      const result = await testProxyConnection(orgId, proxyId);
      if (result.error === "PROXY_NOT_FOUND") {
        throw notFound("Proxy not found");
      }
      return c.json(result);
    } catch (err) {
      logger.error("Proxy test failed", {
        proxyId,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // PUT /api/proxies/:id — update a custom proxy
  router.put("/:id", requirePermission("proxies", "write"), async (c) => {
    const orgId = c.get("orgId");
    const proxyId = c.req.param("id")!;
    const body = await c.req.json();
    const data = parseBody(updateProxySchema, body);

    if (isSystemProxy(proxyId)) {
      throw systemEntityForbidden("proxy", proxyId);
    }

    try {
      await updateOrgProxy(orgId, proxyId, data);
      await recordAuditFromContext(c, {
        action: "proxy.updated",
        resourceType: "proxy",
        resourceId: proxyId,
        after: data as unknown as Record<string, unknown>,
      });
      // Return the bare updated resource — same shape as the GET list
      // serializer — so callers don't need a follow-up GET (#657).
      const proxy = await getOrgProxy(orgId, proxyId);
      if (!proxy) throw notFound("Proxy not found");
      return c.json(proxy);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const msg = getErrorMessage(err);
      if (msg.includes("blocked network")) {
        throw new ApiError({ status: 400, code: "blocked_url", title: "Bad Request", detail: msg });
      }
      logger.error("Proxy update failed", { proxyId, error: msg });
      throw internalError();
    }
  });

  // DELETE /api/proxies/:id — delete a custom proxy
  router.delete("/:id", requirePermission("proxies", "delete"), async (c) => {
    const orgId = c.get("orgId");
    const proxyId = c.req.param("id")!;

    if (isSystemProxy(proxyId)) {
      throw systemEntityForbidden("proxy", proxyId, "delete");
    }

    try {
      await deleteOrgProxy(orgId, proxyId);
      await recordAuditFromContext(c, {
        action: "proxy.deleted",
        resourceType: "proxy",
        resourceId: proxyId,
      });
      return c.body(null, 204);
    } catch (err) {
      logger.error("Proxy delete failed", {
        proxyId,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  return router;
}
