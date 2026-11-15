// SPDX-License-Identifier: Apache-2.0

/**
 * The lists spanning the spaces of one organization — runs, schedules, files
 * and the package indexes: read-only. Each is its single-space list with one
 * grant per space it admits.
 */

import { Hono } from "hono";
import {
  canReadRuns,
  packagePermission,
  packageSightPermissions,
  RUNS_READ_PERMISSIONS,
} from "@appstrate/core/permissions";
import type { PACKAGE_TYPE_ROUTE_SEGMENT } from "@appstrate/core/package-files";
import type { PackageType } from "@appstrate/core/validation";
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
import { packageAccessSpaces } from "../lib/package-access.ts";
import { fileLifecycleCeiling } from "./files.ts";
import { listSpaceAgents } from "./agents.ts";
import { listSpacePackages } from "./packages.ts";

/**
 * The package indexes served across spaces besides the agents' own, each with
 * its `GET /api/packages/{segment}` path segment — spelled out so the route
 * table reads as literals, and checked against `PACKAGE_TYPE_ROUTE_SEGMENT`.
 */
const INDEXED_PACKAGE_TYPES = [
  { type: "skill", segment: "skills" },
  { type: "integration", segment: "integrations" },
  { type: "mcp-server", segment: "mcp-servers" },
] as const satisfies readonly {
  [T in PackageType]: { type: T; segment: (typeof PACKAGE_TYPE_ROUTE_SEGMENT)[T] };
}[PackageType][];

export function createCrossSpaceReadsRouter() {
  const router = new Hono<AppEnv>();

  // No space is entered here, so a space-level guard could never pass: the
  // authorization IS the per-space grant list, read from the caller's role in
  // each space they reach (a pinned credential reaches its space only). The
  // ceiling guard refuses a delegated credential whose scopes omit the list's
  // read permission, instead of answering it an empty page. Each route resolves
  // its spaces before parsing any parameter, so a refused end-user is a 403
  // whatever its query.

  router.get(
    "/:orgId/runs",
    requireOrgPathMembership,
    requireAnyCeiling(RUNS_READ_PERMISSIONS),
    async (c) => {
      const orgId = c.req.param("orgId")!;
      const spaces = await readableSpacesAcross(c, orgId, (permissions) =>
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
      const spaces = await readableSpacesAcross(c, orgId, (permissions) =>
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
      const spaces = await readableSpacesAcross(c, orgId, (permissions) =>
        permissions.has("files:read"),
      );
      const filters = parseListFilesQuery(c);
      const grants = spaces.map((space) => fileReadGrant(space.id, space.permissions));
      return c.json(
        await listFilesForActor(orgId, grants, getActor(c), filters, fileLifecycleCeiling(c)),
      );
    },
  );

  const agentSight = packageSightPermissions("agent");
  router.get(
    "/:orgId/agents",
    requireOrgPathMembership,
    requireAnyCeiling(agentSight),
    async (c) => {
      const orgId = c.req.param("orgId")!;
      const spaces = await readableSpacesAcross(c, orgId, (permissions) =>
        agentSight.some((permission) => permissions.has(permission)),
      );
      const actor = getActor(c);
      const pages = await Promise.all(
        spaces.map((space) =>
          listSpaceAgents({ orgId, spaceId: space.id }, space.permissions, actor),
        ),
      );
      return c.json(listResponse(pages.flat()));
    },
  );

  for (const { type, segment } of INDEXED_PACKAGE_TYPES) {
    const read = packagePermission(type, "read");
    router.get(
      `/:orgId/packages/${segment}`,
      requireOrgPathMembership,
      requireAnyCeiling([read]),
      async (c) => {
        const orgId = c.req.param("orgId")!;
        const spaces = await readableSpacesAcross(c, orgId, (permissions) => permissions.has(read));
        const accessible = await packageAccessSpaces(c);
        const pages = await Promise.all(
          spaces.map((space) => listSpacePackages(type, { orgId, spaceId: space.id }, accessible)),
        );
        return c.json(listResponse(pages.flat()));
      },
    );
  }

  return router;
}
