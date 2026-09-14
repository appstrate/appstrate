// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { managesOrgCatalog } from "../lib/package-access.ts";
import { forbidden } from "../lib/errors.ts";
import { getPackageLibrary } from "../services/package-library.ts";
import type { AppEnv } from "../types/index.ts";

export function createLibraryRouter() {
  const router = new Hono<AppEnv>();
  router.get("/", async (c) => {
    if (!managesOrgCatalog(c))
      throw forbidden("The organization library requires an owner or admin");
    return c.json(await getPackageLibrary(c));
  });
  return router;
}
