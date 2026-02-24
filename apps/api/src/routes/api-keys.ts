import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { requireAdmin } from "../middleware/guards.ts";
import { logger } from "../lib/logger.ts";
import {
  generateApiKey,
  hashApiKey,
  extractKeyPrefix,
  createApiKeyRecord,
  listApiKeys,
  revokeApiKey,
} from "../services/api-keys.ts";

const createApiKeySchema = z.object({
  name: z.string().min(1, "name is required").max(100, "name must be 100 characters or less"),
  expiresAt: z.iso
    .datetime({ message: "expiresAt must be a valid ISO 8601 date" })
    .refine((d) => new Date(d) > new Date(), { message: "expiresAt must be in the future" })
    .nullable()
    .optional(),
});

export function createApiKeysRouter() {
  const router = new Hono<AppEnv>();

  // All endpoints are admin-only
  router.use("*", requireAdmin());

  // GET /api/api-keys — list active keys for the org
  router.get("/", async (c) => {
    const orgId = c.get("orgId");
    const keys = await listApiKeys(orgId);
    return c.json({ apiKeys: keys });
  });

  // POST /api/api-keys — create a new key (returns raw key ONCE)
  router.post("/", async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const body = await c.req.json();
    const parsed = createApiKeySchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", message: parsed.error.issues[0]!.message }, 400);
    }

    const { name, expiresAt } = parsed.data;
    const rawKey = generateApiKey();
    const keyHash = await hashApiKey(rawKey);
    const keyPrefix = extractKeyPrefix(rawKey);

    try {
      const id = await createApiKeyRecord({
        orgId,
        name,
        keyHash,
        keyPrefix,
        createdBy: user.id,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      });

      return c.json({ id, key: rawKey, keyPrefix }, 201);
    } catch (err) {
      logger.error("API key creation failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to create API key" }, 500);
    }
  });

  // DELETE /api/api-keys/:id — revoke a key (soft-delete)
  router.delete("/:id", async (c) => {
    const orgId = c.get("orgId");
    const keyId = c.req.param("id");

    try {
      const revoked = await revokeApiKey(keyId, orgId);
      if (!revoked) {
        return c.json({ error: "NOT_FOUND", message: "API key not found or already revoked" }, 404);
      }
      return c.body(null, 204);
    } catch (err) {
      logger.error("API key revocation failed", {
        keyId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to revoke API key" }, 500);
    }
  });

  return router;
}
