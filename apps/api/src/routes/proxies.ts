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
  createOrgProxy,
  updateOrgProxy,
  deleteOrgProxy,
  setDefaultProxy,
  testProxyConnection,
} from "../services/org-proxies.ts";
import { logger } from "../lib/logger.ts";
import {
  ApiError,
  notFound,
  internalError,
  parseBody,
  systemEntityForbidden,
} from "../lib/errors.ts";

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
      return c.json({ id }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
      return c.json({ success: true });
    } catch (err) {
      logger.error("Set default proxy failed", {
        error: err instanceof Error ? err.message : String(err),
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
        error: err instanceof Error ? err.message : String(err),
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
      return c.json({ id: proxyId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
      return c.body(null, 204);
    } catch (err) {
      logger.error("Proxy delete failed", {
        proxyId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }
  });

  return router;
}
