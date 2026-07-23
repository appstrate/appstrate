// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { unauthorized } from "../lib/errors.ts";
import { getVersionInfo } from "../lib/version.ts";
import { getUpdateChecker } from "../services/update-check.ts";

/**
 * GET /api/version — running build identity + update availability (#694).
 *
 * Session-gated (any authenticated caller — session or API key): the running
 * version is already visible to operators via /health, but the update-check
 * result stays behind auth so anonymous crawlers can neither fingerprint
 * outdated instances nor burn the server-side GitHub check cache.
 */
export function createVersionRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get("/version", async (c) => {
    if (!c.get("user")?.id) {
      throw unauthorized("Not authenticated");
    }
    const update = await getUpdateChecker().getStatus();
    return c.json({ version: getVersionInfo(), update });
  });

  return router;
}
