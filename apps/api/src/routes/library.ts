// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { forbidden } from "../lib/errors.ts";
import { callerOrgRole } from "../lib/view-as.ts";
import { isUserPrincipal } from "../lib/principal.ts";
import { getPackageLibrary } from "../services/package-library.ts";
import type { AppEnv } from "../types/index.ts";

/**
 * Who may open the ORGANIZATION-wide library page — the person's own
 * credential holding owner or admin, never a delegate (RBAC spec §6.10).
 *
 * This is a PAGE gate and nothing more: the map it guards spans every space of
 * the organization, which is an administrator's view by definition. It confers
 * no authority over any package on it — each row is still placed, read, moved
 * and switched on under the home rule (`packages.home_space_id`), and the
 * per-space page `GET /api/spaces/{id}/library` serves the same projection to
 * whoever reads that one space.
 *
 * A delegate is refused because it is pinned to a single space: an
 * organization map is not a thing a space-pinned credential asks for.
 */
function mayOpenOrganizationLibrary(c: Parameters<typeof callerOrgRole>[0]): boolean {
  const orgRole = callerOrgRole(c);
  return isUserPrincipal(c) && (orgRole === "owner" || orgRole === "admin");
}

export function createLibraryRouter() {
  const router = new Hono<AppEnv>();
  router.get("/", async (c) => {
    if (!mayOpenOrganizationLibrary(c))
      throw forbidden(
        "The organization library requires the user's own credential holding owner or admin",
      );
    return c.json(await getPackageLibrary(c));
  });
  return router;
}
