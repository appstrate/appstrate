// SPDX-License-Identifier: Apache-2.0

/**
 * OIDC module — OAuth client admin routes.
 *
 * All routes are application-scoped (`X-App-Id` required, enforced by the
 * app-context middleware via `appScopedPaths: ["/api/oauth"]` in the module
 * manifest). Callers need `oauth-clients:*` permissions — a new resource
 * contributed to core in the same phase (CLAUDE.md rule: "if a module
 * introduces a new RBAC resource, extend `apps/api/src/lib/permissions.ts`
 * in the same PR").
 *
 * Phase 1 scope: CRUD + rotate. No token issuance from here — tokens are
 * issued by Better Auth's oauth-provider plugin under `/api/auth/oauth2/*`
 * (wired in Stage 5). These routes own the client registry only.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../types/index.ts";
import { rateLimit } from "../../middleware/rate-limit.ts";
import { idempotency } from "../../middleware/idempotency.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import { parseBody, notFound } from "../../lib/errors.ts";
import {
  listClientsForApp,
  getClient,
  createClient,
  deleteClient,
  rotateClientSecret,
  setClientDisabled,
  updateClientRedirectUris,
} from "./services/oauth-admin.ts";

export const createOAuthClientSchema = z.object({
  name: z.string().min(1, "name is required").max(200),
  redirectUris: z.array(z.url("redirectUris must be valid URLs")).min(1),
  scopes: z.array(z.string().min(1)).optional(),
});

export const updateOAuthClientSchema = z.object({
  redirectUris: z.array(z.url()).min(1).optional(),
  disabled: z.boolean().optional(),
});

export function createOidcRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/oauth/clients — register a new OAuth client for the current app.
  // Returns the plaintext clientSecret exactly once (hashed at rest).
  router.post(
    "/oauth/clients",
    rateLimit(10),
    idempotency(),
    requirePermission("oauth-clients", "write"),
    async (c) => {
      const applicationId = c.get("applicationId");
      const body = await c.req.json();
      const data = parseBody(createOAuthClientSchema, body);
      const created = await createClient(applicationId, data);
      return c.json(created, 201);
    },
  );

  // GET /api/oauth/clients — list registered clients for the current app.
  router.get(
    "/oauth/clients",
    rateLimit(300),
    requirePermission("oauth-clients", "read"),
    async (c) => {
      const applicationId = c.get("applicationId");
      const data = await listClientsForApp(applicationId);
      return c.json({ object: "list", data });
    },
  );

  // GET /api/oauth/clients/:clientId — retrieve a single client.
  router.get(
    "/oauth/clients/:clientId",
    rateLimit(300),
    requirePermission("oauth-clients", "read"),
    async (c) => {
      const applicationId = c.get("applicationId");
      const client = await getClient(applicationId, c.req.param("clientId")!);
      if (!client) throw notFound("OAuth client not found");
      return c.json(client);
    },
  );

  // PATCH /api/oauth/clients/:clientId — update redirectUris or disabled flag.
  router.patch(
    "/oauth/clients/:clientId",
    rateLimit(10),
    requirePermission("oauth-clients", "write"),
    async (c) => {
      const applicationId = c.get("applicationId");
      const clientId = c.req.param("clientId")!;
      const body = await c.req.json();
      const data = parseBody(updateOAuthClientSchema, body);

      let current = await getClient(applicationId, clientId);
      if (!current) throw notFound("OAuth client not found");

      if (data.redirectUris !== undefined) {
        current =
          (await updateClientRedirectUris(applicationId, clientId, data.redirectUris)) ?? current;
      }
      if (data.disabled !== undefined) {
        current = (await setClientDisabled(applicationId, clientId, data.disabled)) ?? current;
      }
      return c.json(current);
    },
  );

  // DELETE /api/oauth/clients/:clientId — remove a client.
  router.delete(
    "/oauth/clients/:clientId",
    rateLimit(10),
    requirePermission("oauth-clients", "delete"),
    async (c) => {
      const applicationId = c.get("applicationId");
      const deleted = await deleteClient(applicationId, c.req.param("clientId")!);
      if (!deleted) throw notFound("OAuth client not found");
      return c.body(null, 204);
    },
  );

  // POST /api/oauth/clients/:clientId/rotate — issue a fresh clientSecret.
  router.post(
    "/oauth/clients/:clientId/rotate",
    rateLimit(5),
    requirePermission("oauth-clients", "write"),
    async (c) => {
      const applicationId = c.get("applicationId");
      const rotated = await rotateClientSecret(applicationId, c.req.param("clientId")!);
      if (!rotated) throw notFound("OAuth client not found");
      return c.json(rotated);
    },
  );

  return router;
}
