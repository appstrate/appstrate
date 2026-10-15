// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { forbidden } from "../lib/errors.ts";
import { isUserPrincipal } from "../lib/principal.ts";
import { getPackageLibrary } from "../services/package-library.ts";
import type { AppEnv } from "../types/index.ts";

/**
 * Who may open the ORGANIZATION-wide library — the person's own credential,
 * never a delegate (RBAC spec §6.10). A delegate is refused because it is
 * pinned to a single space: an organization map is not a thing a space-pinned
 * credential asks for.
 *
 * Every member may: the map is graded by the caller, each space listed only
 * where its own library page (`GET /api/spaces/{id}/library`) would answer
 * them, so it is the union of those pages. It confers no authority over any
 * package on it — each row is still placed, read, moved and switched on under
 * the home rule (`packages.home_space_id`).
 */
export function createLibraryRouter() {
  const router = new Hono<AppEnv>();
  // The credential decides, not a grant: the graded map needs none of its own.
  router.get("/", async (c) => {
    if (!isUserPrincipal(c))
      throw forbidden("The organization library requires the user's own credential");
    return c.json(await getPackageLibrary(c));
  });
  return router;
}
