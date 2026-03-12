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

const createProxySchema = z.object({
  label: z.string().min(1, "label is required"),
  url: z.string().min(1, "url is required"),
});

const updateProxySchema = z.object({
  label: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
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
      return c.json({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]!.message }, 400);
    }

    try {
      const id = await createOrgProxy(orgId, parsed.data.label, parsed.data.url, user.id);
      return c.json({ id }, 201);
    } catch (err) {
      logger.error("Proxy create failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to create proxy" }, 500);
    }
  });

  // PUT /api/proxies/default — set the org default proxy
  // MUST be registered before PUT /:id
  router.put("/default", async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const parsed = setDefaultSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]!.message }, 400);
    }

    try {
      await setDefaultProxy(orgId, parsed.data.proxyId);
      return c.json({ success: true });
    } catch (err) {
      logger.error("Set default proxy failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to set default proxy" }, 500);
    }
  });

  // POST /api/proxies/:id/test — test proxy connection
  router.post("/:id/test", rateLimit(5), async (c) => {
    const orgId = c.get("orgId");
    const proxyId = c.req.param("id")!;
    try {
      const result = await testProxyConnection(orgId, proxyId);
      return c.json(result, result.error === "PROXY_NOT_FOUND" ? 404 : 200);
    } catch (err) {
      logger.error("Proxy test failed", {
        proxyId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(
        { ok: false, latency: 0, error: "INTERNAL_ERROR", message: "Test failed" },
        500,
      );
    }
  });

  // PUT /api/proxies/:id — update a custom proxy
  router.put("/:id", async (c) => {
    const orgId = c.get("orgId");
    const proxyId = c.req.param("id");
    const body = await c.req.json();
    const parsed = updateProxySchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]!.message }, 400);
    }

    if (isSystemProxy(proxyId)) {
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: `Cannot modify built-in proxy '${proxyId}'` },
        403,
      );
    }

    try {
      await updateOrgProxy(orgId, proxyId, parsed.data);
      return c.json({ id: proxyId });
    } catch (err) {
      logger.error("Proxy update failed", {
        proxyId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to update proxy" }, 500);
    }
  });

  // DELETE /api/proxies/:id — delete a custom proxy
  router.delete("/:id", async (c) => {
    const orgId = c.get("orgId");
    const proxyId = c.req.param("id");

    if (isSystemProxy(proxyId)) {
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: `Cannot delete built-in proxy '${proxyId}'` },
        403,
      );
    }

    try {
      await deleteOrgProxy(orgId, proxyId);
      return c.body(null, 204);
    } catch (err) {
      logger.error("Proxy delete failed", {
        proxyId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to delete proxy" }, 500);
    }
  });

  return router;
}
