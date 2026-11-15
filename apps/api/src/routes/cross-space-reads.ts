// SPDX-License-Identifier: Apache-2.0

/**
 * The lists spanning the spaces of one organization — runs, schedules, files:
 * read-only. Each is its single-space list with one grant per space it admits.
 */

import { Hono } from "hono";
import { canReadRuns, RUNS_READ_PERMISSIONS } from "@appstrate/core/permissions";
import type { AppEnv } from "../types/index.ts";
import { requireOrgPathMembership } from "../middleware/org-path-context.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requireAnyCeiling, requireCeiling } from "../middleware/require-permission.ts";
import { listGlobalRuns } from "../services/state/runs.ts";
import { listSchedules } from "../services/scheduler.ts";
import { fileReadGrant, listFilesForActor } from "../services/files.ts";
import { readableSpacesAcross } from "../lib/reachable-spaces.ts";
import { runReadGrant } from "../lib/run-visibility.ts";
import { getActor } from "../lib/actor.ts";
import { listResponse } from "../lib/list-response.ts";
import { setOffsetLinkHeader } from "../lib/pagination-link.ts";
import { parseGlobalRunListQuery } from "../lib/run-list-query.ts";
import { parseListFilesQuery } from "../lib/file-list-query.ts";
import { fileLifecycleCeiling } from "./files.ts";

export function createCrossSpaceReadsRouter() {
  const router = new Hono<AppEnv>();

  // No space is entered here, so a space-level guard could never pass: the
  // authorization IS the per-space grant list, read from the caller's role in
  // each space they reach (a pinned credential reaches its space only). The
  // ceiling guard refuses a delegated credential whose scopes omit the list's
  // read permission, instead of answering it an empty page. Each route reads
  // `spaceId` once and resolves its spaces before parsing any other parameter,
  // so a refused end-user is a 403 whatever its query.

  router.get(
    "/:orgId/runs",
    requireOrgPathMembership,
    requireAnyCeiling(RUNS_READ_PERMISSIONS),
    async (c) => {
      const orgId = c.req.param("orgId")!;
      const spaces = await readableSpacesAcross(c, orgId, c.req.query("spaceId"), (permissions) =>
        canReadRuns((p) => permissions.has(p)),
      );
      const filters = parseGlobalRunListQuery(c);
      const grants = spaces.map((space) => runReadGrant(space.id, space.permissions));
      const result = await listGlobalRuns(orgId, grants, { ...filters, actor: getActor(c) });
      setOffsetLinkHeader({ c, limit: filters.limit, offset: filters.offset, total: result.total });
      return c.json(result);
    },
  );

  router.get(
    "/:orgId/schedules",
    requireOrgPathMembership,
    requireCeiling("schedules", "read"),
    async (c) => {
      const orgId = c.req.param("orgId")!;
      const spaces = await readableSpacesAcross(c, orgId, c.req.query("spaceId"), (permissions) =>
        permissions.has("schedules:read"),
      );
      const grants = spaces.map((space) => runReadGrant(space.id, space.permissions));
      return c.json(listResponse(await listSchedules(orgId, grants, getActor(c))));
    },
  );

  router.get(
    "/:orgId/files",
    rateLimit(120),
    requireOrgPathMembership,
    requireCeiling("files", "read"),
    async (c) => {
      const orgId = c.req.param("orgId")!;
      const { spaceId, ...query } = c.req.query();
      const spaces = await readableSpacesAcross(c, orgId, spaceId, (permissions) =>
        permissions.has("files:read"),
      );
      const filters = parseListFilesQuery(c, query);
      const grants = spaces.map((space) => fileReadGrant(space.id, space.permissions));
      return c.json(
        await listFilesForActor(orgId, grants, getActor(c), filters, fileLifecycleCeiling(c)),
      );
    },
  );

  return router;
}
