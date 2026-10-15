// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { ORG_ROLES } from "@appstrate/core/permissions";
import { listResponse } from "../lib/list-response.ts";
import { orgPermissions } from "../lib/permissions.ts";
import type { AppEnv } from "../types/index.ts";

/**
 * The four organization roles and the org-level permissions each grants — the platform's own
 * matrix (`ORG_ROLE_PERMISSIONS`) with what the loaded modules contribute at `level: "org"`, so
 * a reader draws the grants the API enforces instead of copying them. The same in every
 * organization: no persona, no ceiling — it describes the roles, not the caller.
 */
export function createOrgRolesRouter() {
  const router = new Hono<AppEnv>();
  // Membership is the gate (org context): every role reads the roles page.
  router.get("/", (c) =>
    c.json(
      listResponse(
        ORG_ROLES.map((role) => ({
          object: "org_role" as const,
          role,
          permissions: [...orgPermissions(role)].sort(),
        })),
      ),
    ),
  );
  return router;
}
