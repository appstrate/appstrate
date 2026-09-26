// SPDX-License-Identifier: Apache-2.0

/**
 * Org-level integration OAuth clients, mounted under `/api/org-integrations`
 * (org context, no space). An org client is inherited by every space of the
 * org; a space's own client overrides it. Same bodies and audit actions as the
 * space routes of `routes/integrations.ts` — the audit row's null `spaceId`
 * tells the tiers apart.
 *
 *   - `GET    /:packageId/auths/:authKey/clients`
 *   - `PUT    /:packageId/auths/:authKey/default-client`
 *   - `POST   /:packageId/auths/:authKey/oauth-clients`
 *   - `PUT    /:packageId/oauth-clients/:clientId`
 *   - `DELETE /:packageId/oauth-clients/:clientId`
 *
 * Package visibility and auth type (oauth2, not auto-provisioned) are enforced
 * by the service for the org tier.
 */

import { Hono } from "hono";
import { readJsonBody } from "@appstrate/core/request-body";
import type { AppEnv } from "../types/index.ts";
import { listResponse } from "../lib/list-response.ts";
import { getOrgScope } from "../lib/scope.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import {
  createIntegrationOAuthClient,
  deleteIntegrationOAuthClient,
  listIntegrationClients,
  setDefaultIntegrationClient,
  toPublicClient,
  updateIntegrationOAuthClient,
} from "../services/integration-connections.ts";
import {
  assertOAuthClientRowId,
  oauthClientCreateSchema,
  oauthClientUpdateSchema,
  setDefaultClientSchema,
  toOAuthClientCreateInput,
  toOAuthClientUpdateInput,
} from "./integrations.ts";

export function createOrgIntegrationsRouter() {
  const router = new Hono<AppEnv>();
  const configure = requirePermission("org-integrations", "configure");

  router.get("/:packageId{@[^/]+/[^/]+}/auths/:authKey/clients", configure, async (c) => {
    const clients = await listIntegrationClients(
      getOrgScope(c),
      c.req.param("packageId")!,
      c.req.param("authKey")!,
    );
    return c.json(listResponse(clients));
  });

  router.put("/:packageId{@[^/]+/[^/]+}/auths/:authKey/default-client", configure, async (c) => {
    const packageId = c.req.param("packageId")!;
    const authKey = c.req.param("authKey")!;
    const scope = getOrgScope(c);
    const body = await readJsonBody(c, setDefaultClientSchema);
    await setDefaultIntegrationClient(scope, packageId, authKey, body.client_ref);
    await recordAuditFromContext(c, {
      action: "integration.default_client.set",
      resourceType: "integration",
      resourceId: `${packageId}#${authKey}`,
    });
    return c.json(listResponse(await listIntegrationClients(scope, packageId, authKey)));
  });

  router.post("/:packageId{@[^/]+/[^/]+}/auths/:authKey/oauth-clients", configure, async (c) => {
    const packageId = c.req.param("packageId")!;
    const authKey = c.req.param("authKey")!;
    const body = await readJsonBody(c, oauthClientCreateSchema);
    const client = await createIntegrationOAuthClient(
      getOrgScope(c),
      packageId,
      authKey,
      toOAuthClientCreateInput(body),
    );
    await recordAuditFromContext(c, {
      action: "integration.oauth_client.created",
      resourceType: "integration",
      resourceId: `${packageId}#${authKey}#${client.id}`,
    });
    return c.json(toPublicClient(client), 201);
  });

  router.put("/:packageId{@[^/]+/[^/]+}/oauth-clients/:clientId", configure, async (c) => {
    const packageId = c.req.param("packageId")!;
    const clientId = assertOAuthClientRowId(c.req.param("clientId")!);
    const body = await readJsonBody(c, oauthClientUpdateSchema);
    const client = await updateIntegrationOAuthClient(
      getOrgScope(c),
      packageId,
      clientId,
      toOAuthClientUpdateInput(body),
    );
    await recordAuditFromContext(c, {
      action: "integration.oauth_client.rotated",
      resourceType: "integration",
      resourceId: `${packageId}#${client.auth_key}#${clientId}`,
    });
    return c.json(toPublicClient(client));
  });

  // Also deletes every connection of the org's spaces minted by this client.
  router.delete("/:packageId{@[^/]+/[^/]+}/oauth-clients/:clientId", configure, async (c) => {
    const packageId = c.req.param("packageId")!;
    const clientId = assertOAuthClientRowId(c.req.param("clientId")!);
    const { deletedConnections } = await deleteIntegrationOAuthClient(
      getOrgScope(c),
      packageId,
      clientId,
    );
    await recordAuditFromContext(c, {
      action: "integration.oauth_client.deleted",
      resourceType: "integration",
      resourceId: `${packageId}#${clientId}`,
      after: { deletedConnections },
    });
    return c.body(null, 204);
  });

  return router;
}
