// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import { ApiError, internalError, notFound, parseBody } from "../lib/errors.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { validateScopes, resolvePermissions, API_KEY_ALLOWED_SCOPES } from "../lib/permissions.ts";
import {
  generateApiKey,
  hashApiKey,
  extractKeyPrefix,
  createApiKeyRecord,
  listApiKeys,
  revokeApiKey,
} from "../services/api-keys.ts";
import { getAppScope, getOrgScope } from "../lib/scope.ts";

export const createApiKeySchema = z.object({
  name: z.string().min(1, "name is required").max(100, "name must be 100 characters or less"),
  expiresAt: z.iso
    .datetime({ message: "expiresAt must be a valid ISO 8601 date" })
    .refine((d) => new Date(d) > new Date(), { message: "expiresAt must be in the future" })
    .nullable()
    .optional(),
  scopes: z.array(z.string()).optional(),
});

export function createApiKeysRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/api-keys/available-scopes — list scopes available for the current user's role
  // MUST be registered BEFORE /:id routes
  router.get("/available-scopes", requirePermission("api-keys", "read"), async (c) => {
    const orgRole = c.get("orgRole");
    const rolePerms = resolvePermissions(orgRole);
    const available = [...API_KEY_ALLOWED_SCOPES].filter((s) => rolePerms.has(s));
    return c.json({ scopes: available });
  });

  // GET /api/api-keys — list active keys for the current application
  router.get("/", requirePermission("api-keys", "read"), async (c) => {
    const scope = getAppScope(c);
    const keys = await listApiKeys(scope);
    return c.json({ apiKeys: keys });
  });

  // POST /api/api-keys — create a new key (returns raw key ONCE)
  router.post("/", requirePermission("api-keys", "create"), async (c) => {
    const scope = getAppScope(c);
    const user = c.get("user");
    const body = await c.req.json();
    const data = parseBody(createApiKeySchema, body);

    const { name, expiresAt } = data;
    const orgRole = c.get("orgRole");
    // If scopes omitted or empty, grant all API-key-allowed scopes for the creator's role
    const validatedScopes =
      data.scopes && data.scopes.length > 0
        ? validateScopes(data.scopes, orgRole)
        : validateScopes([...API_KEY_ALLOWED_SCOPES], orgRole);

    const rawKey = generateApiKey();
    const keyHash = await hashApiKey(rawKey);
    const keyPrefix = extractKeyPrefix(rawKey);

    try {
      const id = await createApiKeyRecord({
        scope,
        name,
        keyHash,
        keyPrefix,
        createdBy: user.id,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        scopes: validatedScopes,
      });

      return c.json({ id, key: rawKey, keyPrefix, scopes: validatedScopes }, 201);
    } catch (err) {
      logger.error("API key creation failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }
  });

  // DELETE /api/api-keys/:id — revoke a key (soft-delete)
  router.delete("/:id", requirePermission("api-keys", "revoke"), async (c) => {
    const keyId = c.req.param("id")!;
    // Issue #172 (extension): API keys may only revoke keys within their
    // own bound application. Sessions retain org-wide reach (admins manage
    // all apps from the dashboard) — the scope's shape encodes the intent
    // at the type level.
    const scope = c.get("authMethod") === "api_key" ? getAppScope(c) : getOrgScope(c);

    try {
      const revoked = await revokeApiKey(scope, keyId);
      if (!revoked) {
        throw notFound("API key not found or already revoked");
      }
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("API key revocation failed", {
        keyId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }
  });

  return router;
}
