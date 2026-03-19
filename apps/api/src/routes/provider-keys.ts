import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { requireAdmin } from "../middleware/guards.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { isSystemProviderKey } from "../services/model-registry.ts";
import {
  listOrgProviderKeys,
  createOrgProviderKey,
  updateOrgProviderKey,
  deleteOrgProviderKey,
  testProviderKeyConnection,
  loadProviderKeyCredentials,
} from "../services/org-provider-keys.ts";
import { testModelConfig } from "../services/org-models.ts";
import { logger } from "../lib/logger.ts";

const createSchema = z.object({
  label: z.string().min(1, "label is required"),
  api: z.string().min(1, "api is required"),
  baseUrl: z.url({ error: "baseUrl must be a valid URL" }),
  apiKey: z.string().min(1, "apiKey is required"),
});

const updateSchema = z.object({
  label: z.string().min(1).optional(),
  api: z.string().min(1).optional(),
  baseUrl: z.url().optional(),
  apiKey: z.string().min(1).optional(),
});

const testInlineSchema = z.object({
  api: z.string().min(1),
  baseUrl: z.url(),
  apiKey: z.string().optional(),
  existingKeyId: z.string().optional(),
});

export function createProviderKeysRouter() {
  const router = new Hono<AppEnv>();
  router.use("*", requireAdmin());

  // GET /api/provider-keys
  router.get("/", async (c) => {
    const orgId = c.get("orgId");
    const keys = await listOrgProviderKeys(orgId);
    return c.json({ keys });
  });

  // POST /api/provider-keys
  router.post("/", async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const body = await c.req.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]!.message }, 400);
    }
    try {
      const { label, api, baseUrl, apiKey } = parsed.data;
      const id = await createOrgProviderKey(orgId, label, api, baseUrl, apiKey, user.id);
      return c.json({ id }, 201);
    } catch (err) {
      logger.error("Provider key create failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to create provider key" }, 500);
    }
  });

  // POST /api/provider-keys/test — inline test (before saving)
  router.post("/test", rateLimit(5), async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const parsed = testInlineSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]!.message }, 400);
    }
    let { apiKey } = parsed.data;
    if (!apiKey && parsed.data.existingKeyId) {
      const existing = await loadProviderKeyCredentials(orgId, parsed.data.existingKeyId);
      if (existing) apiKey = existing.apiKey;
    }
    if (!apiKey) {
      return c.json(
        { ok: false, latency: 0, error: "VALIDATION_ERROR", message: "API key is required" },
        400,
      );
    }
    try {
      const result = await testModelConfig({
        api: parsed.data.api,
        baseUrl: parsed.data.baseUrl,
        modelId: "_test",
        apiKey,
      });
      return c.json(result);
    } catch (err) {
      logger.error("Provider key inline test failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(
        { ok: false, latency: 0, error: "INTERNAL_ERROR", message: "Test failed" },
        500,
      );
    }
  });

  // POST /api/provider-keys/:id/test
  router.post("/:id/test", rateLimit(5), async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id")!;
    try {
      const result = await testProviderKeyConnection(orgId, id);
      return c.json(result, result.error === "KEY_NOT_FOUND" ? 404 : 200);
    } catch (err) {
      logger.error("Provider key test failed", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(
        { ok: false, latency: 0, error: "INTERNAL_ERROR", message: "Test failed" },
        500,
      );
    }
  });

  // PUT /api/provider-keys/:id
  router.put("/:id", async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id")!;
    if (isSystemProviderKey(id)) {
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: `Cannot modify built-in provider key '${id}'` },
        403,
      );
    }
    const body = await c.req.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]!.message }, 400);
    }
    try {
      await updateOrgProviderKey(orgId, id, parsed.data);
      return c.json({ id });
    } catch (err) {
      logger.error("Provider key update failed", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to update provider key" }, 500);
    }
  });

  // DELETE /api/provider-keys/:id
  router.delete("/:id", async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id")!;
    if (isSystemProviderKey(id)) {
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: `Cannot delete built-in provider key '${id}'` },
        403,
      );
    }
    try {
      await deleteOrgProviderKey(orgId, id);
      return c.body(null, 204);
    } catch (err) {
      logger.error("Provider key delete failed", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to delete provider key" }, 500);
    }
  });

  return router;
}
