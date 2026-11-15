// SPDX-License-Identifier: Apache-2.0

/**
 * The lists spanning the spaces of one organization — runs, schedules, files:
 * read-only. Each is its single-space list with one grant per space it admits.
 */

import { Hono } from "hono";
import { canReadRuns } from "@appstrate/core/permissions";
import type { AppEnv } from "../types/index.ts";
import { requireOrgPathMembership } from "../middleware/org-path-context.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { listGlobalRuns } from "../services/state/runs.ts";
import { listSchedules } from "../services/scheduler.ts";
import { fileReadGrant, listFilesForActor } from "../services/files.ts";
import { readableSpacesAcross } from "../lib/reachable-spaces.ts";
import { runReadGrant } from "../lib/run-visibility.ts";
import { getActor } from "../lib/actor.ts";
import { listResponse } from "../lib/list-response.ts";
import { setOffsetLinkHeader } from "../lib/pagination-link.ts";
import { parseGlobalRunListQuery } from "./runs.ts";
import { fileLifecycleCeiling, orgListFilesQuerySchema, parseListFilesQuery } from "./files.ts";

export function createCrossSpaceReadsRouter() {
  const router = new Hono<AppEnv>();

  // No space is entered here, so a space-level guard could never pass: the
  // authorization IS the per-space grant list, read from the caller's role in
  // each space they reach (a pinned credential reaches its space only).

  router.get("/:orgId/runs", requireOrgPathMembership, async (c) => {
    const orgId = c.req.param("orgId")!;
    const filters = parseGlobalRunListQuery(c);
    const spaces = await readableSpacesAcross(c, orgId, (permissions) =>
      canReadRuns((p) => permissions.has(p)),
    );
    const grants = spaces.map((space) => runReadGrant(space.id, space.permissions));
    const result = await listGlobalRuns(orgId, grants, { ...filters, actor: getActor(c) });
    setOffsetLinkHeader({ c, limit: filters.limit, offset: filters.offset, total: result.total });
    return c.json(result);
  });

  router.get("/:orgId/schedules", requireOrgPathMembership, async (c) => {
    const orgId = c.req.param("orgId")!;
    const spaces = await readableSpacesAcross(c, orgId, (permissions) =>
      permissions.has("schedules:read"),
    );
    const grants = spaces.map((space) => runReadGrant(space.id, space.permissions));
    return c.json(listResponse(await listSchedules(orgId, grants, getActor(c))));
  });

  router.get("/:orgId/files", rateLimit(120), requireOrgPathMembership, async (c) => {
    const orgId = c.req.param("orgId")!;
    const filters = parseListFilesQuery(c, orgListFilesQuerySchema);
    const spaces = await readableSpacesAcross(c, orgId, (permissions) =>
      permissions.has("files:read"),
    );
    const grants = spaces.map((space) => fileReadGrant(space.id, space.permissions));
    return c.json(
      await listFilesForActor(orgId, grants, getActor(c), filters, fileLifecycleCeiling(c)),
    );
  });

  return router;
}
