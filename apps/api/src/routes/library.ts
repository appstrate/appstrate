// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { forbidden } from "../lib/errors.ts";
import { callerOrgRole } from "../lib/view-as.ts";
import { getPackageLibrary } from "../services/package-library.ts";
import type { AppEnv } from "../types/index.ts";

/**
 * Who may open the ORGANIZATION-wide library page — a session-borne owner or
 * admin, never an API key (RBAC spec §6.10).
 *
 * This is a PAGE gate and nothing more: the map it guards spans every space of
 * the organization, which is an administrator's view by definition. It confers
 * no authority over any package on it — each row is still placed, read, moved
 * and switched on under the home rule (`packages.home_space_id`), and the
 * per-space page `GET /api/spaces/{id}/library` serves the same projection to
 * whoever reads that one space.
 *
 * An API key is refused because it is pinned to a single space: an
 * organization map is not a thing a space-pinned credential asks for.
 */
function mayOpenOrganizationLibrary(c: Parameters<typeof callerOrgRole>[0]): boolean {
  const orgRole = callerOrgRole(c);
  return c.get("authMethod") !== "api_key" && (orgRole === "owner" || orgRole === "admin");
}

export function createLibraryRouter() {
  const router = new Hono<AppEnv>();
  router.get("/", async (c) => {
    if (!mayOpenOrganizationLibrary(c))
      throw forbidden("The organization library requires an owner or admin");
    return c.json(await getPackageLibrary(c));
  });
  return router;
}
