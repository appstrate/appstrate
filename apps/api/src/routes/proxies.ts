import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { requireAdmin } from "../middleware/guards.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
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
import { ApiError, invalidRequest, notFound, internalError } from "../lib/errors.ts";

const createProxySchema = z.object({
  label: z.string().min(1, "label is required"),
  url: z.url({ error: "url must be a valid URL" }),
});

const updateProxySchema = z.object({
  label: z.string().min(1).optional(),
  url: z.url().optional(),
  enabled: z.boolean().optional(),
});

const setDefaultSchema = z.object({
  proxyId: z.string().nullable(),
});

export function createProxiesRouter() {
  const router = new Hono<AppEnv>();

  // All endpoints are admin-only
  router.use("*", requireAdmin());

  // GET /api/proxies — list all proxies (system + DB)
  router.get("/", async (c) => {
    const orgId = c.get("orgId");
    const proxies = await listOrgProxies(orgId);
    return c.json({ proxies });
  });

  // POST /api/proxies — create a custom proxy
  router.post("/", async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const body = await c.req.json();
    const parsed = createProxySchema.safeParse(body);

    if (!parsed.success) {
      throw invalidRequest(parsed.error.issues[0]!.message);
    }

    try {
      const id = await createOrgProxy(orgId, parsed.data.label, parsed.data.url, user.id);
      return c.json({ id }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("blocked network")) {
        throw new ApiError({ status: 400, code: "blocked_url", title: "Bad Request", detail: msg });
      }
      logger.error("Proxy create failed", { error: msg });
      throw internalError("Failed to create proxy");
    }
  });

  // PUT /api/proxies/default — set the org default proxy
  // MUST be registered before PUT /:id
  router.put("/default", async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const parsed = setDefaultSchema.safeParse(body);

    if (!parsed.success) {
      throw invalidRequest(parsed.error.issues[0]!.message);
    }

    try {
      await setDefaultProxy(orgId, parsed.data.proxyId);
      return c.json({ success: true });
    } catch (err) {
      logger.error("Set default proxy failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError("Failed to set default proxy");
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
      throw internalError("Test failed");
    }
  });

  // PUT /api/proxies/:id — update a custom proxy
  router.put("/:id", async (c) => {
    const orgId = c.get("orgId");
    const proxyId = c.req.param("id");
    const body = await c.req.json();
    const parsed = updateProxySchema.safeParse(body);

    if (!parsed.success) {
      throw invalidRequest(parsed.error.issues[0]!.message);
    }

    if (isSystemProxy(proxyId)) {
      throw new ApiError({
        status: 403,
        code: "operation_not_allowed",
        title: "Forbidden",
        detail: `Cannot modify built-in proxy '${proxyId}'`,
      });
    }

    try {
      await updateOrgProxy(orgId, proxyId, parsed.data);
      return c.json({ id: proxyId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("blocked network")) {
        throw new ApiError({ status: 400, code: "blocked_url", title: "Bad Request", detail: msg });
      }
      logger.error("Proxy update failed", { proxyId, error: msg });
      throw internalError("Failed to update proxy");
    }
  });

  // DELETE /api/proxies/:id — delete a custom proxy
  router.delete("/:id", async (c) => {
    const orgId = c.get("orgId");
    const proxyId = c.req.param("id");

    if (isSystemProxy(proxyId)) {
      throw new ApiError({
        status: 403,
        code: "operation_not_allowed",
        title: "Forbidden",
        detail: `Cannot delete built-in proxy '${proxyId}'`,
      });
    }

    try {
      await deleteOrgProxy(orgId, proxyId);
      return c.body(null, 204);
    } catch (err) {
      logger.error("Proxy delete failed", {
        proxyId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError("Failed to delete proxy");
    }
  });

  return router;
}
