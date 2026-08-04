// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { AppEnv } from "../../types/index.ts";
import { SCOPED_PACKAGE_ROUTE } from "../../routes/scoped-package-route.ts";
import { requireAgent } from "../../middleware/guards.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import { notFound } from "../../lib/errors.ts";
import { buildAgentMap } from "./service.ts";

/**
 * The module declares the FULL path (`/api/agents/...`) — the platform mounts
 * module routers at the origin root and injects no prefix.
 *
 * Mount order is safe despite core's agents router registering first: every
 * core route under that prefix ends in a literal suffix (`/config`, `/proxy`,
 * `/model`, `/persistence`, `/bundle`, …) and `SCOPED_PACKAGE_ROUTE`'s `:name`
 * pattern excludes `/`, so no core pattern can swallow the `/map` segment.
 */
export function createAgentMapRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/agents/:scope/:name/map — visual map of the agent: manifest
  // projection (triggers, schedules, toolbox, skills, mcp servers) crossed with
  // the installation state, plus readiness diagnostics routed to the node they
  // belong to. Read-only — owns no data and adds no verdict of its own.
  router.get(
    `/api/agents/${SCOPED_PACKAGE_ROUTE}/map`,
    requireAgent(),
    requirePermission("agents", "read"),
    async (c) => {
      const agent = c.get("package");
      const version = c.req.query("version");
      const map = await buildAgentMap(c, {
        itemId: agent.id,
        ...(version ? { version } : {}),
      });
      if (!map) throw notFound(`Agent '${agent.id}' not found`);
      return c.json(map);
    },
  );

  return router;
}
