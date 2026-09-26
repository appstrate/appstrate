// SPDX-License-Identifier: Apache-2.0

/** Org-level OAuth clients, inherited by every space; handlers shared with `routes/integrations.ts`. */

import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { getOrgScope } from "../lib/scope.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { oauthClientHandlers } from "./integrations.ts";

export function createOrgIntegrationsRouter() {
  const router = new Hono<AppEnv>();
  const clients = oauthClientHandlers(getOrgScope);
  const configure = requirePermission("org-integrations", "configure");
  router.get("/:packageId{@[^/]+/[^/]+}/auths/:authKey/clients", configure, clients.list);
  router.put(
    "/:packageId{@[^/]+/[^/]+}/auths/:authKey/default-client",
    configure,
    clients.setDefault,
  );
  router.post("/:packageId{@[^/]+/[^/]+}/auths/:authKey/oauth-clients", configure, clients.create);
  router.put("/:packageId{@[^/]+/[^/]+}/oauth-clients/:clientId", configure, clients.rotate);
  // Also deletes every connection the client minted in any space of the org.
  router.delete("/:packageId{@[^/]+/[^/]+}/oauth-clients/:clientId", configure, clients.remove);
  return router;
}
