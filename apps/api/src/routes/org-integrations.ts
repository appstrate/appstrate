// SPDX-License-Identifier: Apache-2.0

/** Org-level OAuth clients, inherited by every space; handlers shared with `routes/integrations.ts`. */

import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { getOrgScope } from "../lib/scope.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { oauthClientHandlers } from "./integrations.ts";

export function createOrgIntegrationsRouter() {
  const router = new Hono<AppEnv>();
  const clients = oauthClientHandlers(
    getOrgScope,
    (c) => `${c.req.param("scope")!}/${c.req.param("name")!}`,
  );
  const configure = requirePermission("org-integrations", "configure");
  router.get("/:scope{@[^/]+}/:name/auths/:authKey/clients", configure, clients.list);
  router.put("/:scope{@[^/]+}/:name/auths/:authKey/default-client", configure, clients.setDefault);
  router.post("/:scope{@[^/]+}/:name/auths/:authKey/oauth-clients", configure, clients.create);
  router.put("/:scope{@[^/]+}/:name/oauth-clients/:clientId", configure, clients.rotate);
  // Also deletes every connection the client minted in any space of the org.
  router.delete("/:scope{@[^/]+}/:name/oauth-clients/:clientId", configure, clients.remove);
  return router;
}
