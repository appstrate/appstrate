// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import { ApiError, internalError, notFound } from "../lib/errors.ts";
import { readJsonBody } from "../lib/request-body.ts";
import { listResponse } from "../lib/list-response.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { validateScopes, getApiKeyAllowedScopes } from "../lib/permissions.ts";
import {
  generateApiKey,
  hashApiKey,
  extractKeyPrefix,
  createApiKeyRecord,
  listApiKeys,
  revokeApiKey,
} from "../services/api-keys.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { getSpaceScope, getOrgScope } from "../lib/scope.ts";
import { recordAuditFromContext } from "../services/audit.ts";

export const createApiKeySchema = z
  .object({
    name: z.string().min(1, "name is required").max(100, "name must be 100 characters or less"),
    expiresAt: z.iso
      .datetime({ message: "expiresAt must be a valid ISO 8601 date" })
      .refine((d) => new Date(d) > new Date(), { message: "expiresAt must be in the future" })
      .nullable()
      .optional(),
    scopes: z.array(z.string()).optional(),
  })
  .strict();

/**
 * The caller's effective permissions for this request. Non-empty by
 * construction — every route below is behind an `api-keys:*` guard, which
 * reads the same Set — so the fallback is a fail-closed backstop, not a branch.
 */
function callerEffectivePermissions(c: Context<AppEnv>): ReadonlySet<string> {
  return c.get("permissions") ?? new Set<string>();
}

export function createApiKeysRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/api-keys/available-scopes — list scopes available for the current user's role
  // MUST be registered BEFORE /:id routes
  router.get("/available-scopes", requirePermission("api-keys", "read"), async (c) => {
    // The caller's EFFECTIVE set in this space — `/api/api-keys` is
    // space-scoped, so `permissions` already is it. A `builder` sees no
    // `api-keys:*` here, which is the same answer `POST` gives.
    const effective = callerEffectivePermissions(c);
    const available = [...getApiKeyAllowedScopes()].filter((s) => effective.has(s));
    return c.json(listResponse(available));
  });

  // GET /api/api-keys — list active keys for the current space
  router.get("/", requirePermission("api-keys", "read"), async (c) => {
    const scope = getSpaceScope(c);
    const keys = await listApiKeys(scope);
    return c.json(listResponse(keys));
  });

  // POST /api/api-keys — create a new key (returns raw key ONCE)
  router.post("/", requirePermission("api-keys", "create"), async (c) => {
    const scope = getSpaceScope(c);
    const user = c.get("user");
    const data = await readJsonBody(c, createApiKeySchema);

    const { name, expiresAt } = data;
    // A key delegates its creator's effective set IN THIS SPACE (RBAC spec
    // §7.1). The request that mints it is space-scoped, so `permissions` IS
    // that set — recomputing it would be a second, drift-prone derivation.
    const creatorEffective = callerEffectivePermissions(c);
    // If scopes omitted or empty, grant all API-key-allowed scopes the creator
    // holds. That branch hands `validateScopes` the allowlist itself, so it
    // cannot trip the refusal — only the caller-supplied branch can, and only
    // on a scope no API key could ever carry.
    const validatedScopes =
      data.scopes && data.scopes.length > 0
        ? validateScopes(data.scopes, creatorEffective)
        : validateScopes([...getApiKeyAllowedScopes()], creatorEffective);

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

      await recordAuditFromContext(c, {
        action: "api_key.created",
        resourceType: "api_key",
        resourceId: id,
        after: { name, keyPrefix, scopes: validatedScopes, expiresAt },
      });

      return c.json({ id, key: rawKey, keyPrefix, scopes: validatedScopes }, 201);
    } catch (err) {
      logger.error("API key creation failed", {
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // DELETE /api/api-keys/:id — revoke a key (soft-delete)
  router.delete("/:id", requirePermission("api-keys", "revoke"), async (c) => {
    const keyId = c.req.param("id")!;
    // Issue #172 (extension): API keys may only revoke keys within their
    // own bound space. Sessions retain org-wide reach (admins manage
    // all spaces from the dashboard) — the scope's shape encodes the intent
    // at the type level.
    const scope = c.get("authMethod") === "api_key" ? getSpaceScope(c) : getOrgScope(c);

    try {
      const revoked = await revokeApiKey(scope, keyId);
      if (!revoked) {
        throw notFound("API key not found or already revoked");
      }
      await recordAuditFromContext(c, {
        action: "api_key.revoked",
        resourceType: "api_key",
        resourceId: keyId,
      });
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("API key revocation failed", {
        keyId,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  return router;
}
