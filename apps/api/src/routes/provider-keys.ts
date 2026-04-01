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
import {
  invalidRequest,
  notFound,
  internalError,
  parseBody,
  systemEntityForbidden,
} from "../lib/errors.ts";

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
    const data = parseBody(createSchema, body);
    try {
      const { label, api, baseUrl, apiKey } = data;
      const id = await createOrgProviderKey(orgId, label, api, baseUrl, apiKey, user.id);
      return c.json({ id }, 201);
    } catch (err) {
      logger.error("Provider key create failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }
  });

  // POST /api/provider-keys/test — inline test (before saving)
  router.post("/test", rateLimit(5), async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const data = parseBody(testInlineSchema, body);
    let { apiKey } = data;
    if (!apiKey && data.existingKeyId) {
      const existing = await loadProviderKeyCredentials(orgId, data.existingKeyId);
      if (existing) apiKey = existing.apiKey;
    }
    if (!apiKey) {
      throw invalidRequest("API key is required");
    }
    try {
      const result = await testModelConfig({
        api: data.api,
        baseUrl: data.baseUrl,
        modelId: "_test",
        apiKey,
      });
      return c.json(result);
    } catch (err) {
      logger.error("Provider key inline test failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }
  });

  // POST /api/provider-keys/:id/test
  router.post("/:id/test", rateLimit(5), async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id")!;
    try {
      const result = await testProviderKeyConnection(orgId, id);
      if (result.error === "KEY_NOT_FOUND") {
        throw notFound("Provider key not found");
      }
      return c.json(result);
    } catch (err) {
      logger.error("Provider key test failed", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }
  });

  // PUT /api/provider-keys/:id
  router.put("/:id", async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id")!;
    if (isSystemProviderKey(id)) {
      throw systemEntityForbidden("provider key", id);
    }
    const body = await c.req.json();
    const data = parseBody(updateSchema, body);
    try {
      await updateOrgProviderKey(orgId, id, data);
      return c.json({ id });
    } catch (err) {
      logger.error("Provider key update failed", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }
  });

  // DELETE /api/provider-keys/:id
  router.delete("/:id", async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id")!;
    if (isSystemProviderKey(id)) {
      throw systemEntityForbidden("provider key", id, "delete");
    }
    try {
      await deleteOrgProviderKey(orgId, id);
      return c.body(null, 204);
    } catch (err) {
      logger.error("Provider key delete failed", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }
  });

  return router;
}
