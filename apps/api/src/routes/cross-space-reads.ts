// SPDX-License-Identifier: Apache-2.0

/**
 * The lists spanning the spaces of one organization — runs, schedules, files
 * and the package indexes: read-only. Each is its single-space list with one
 * grant per space it admits.
 */

import { Hono, type Context } from "hono";
import {
  packagePermission,
  packageSightPermissions,
  RUNS_READ_PERMISSIONS,
} from "@appstrate/core/permissions";
import type { PACKAGE_TYPE_ROUTE_SEGMENT } from "@appstrate/core/package-files";
import type { PackageType } from "@appstrate/core/validation";
import type { AppEnv } from "../types/index.ts";
import { requireOrgPathMembership } from "../middleware/org-path-context.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requireAnyCeiling } from "../middleware/require-permission.ts";
import { readableSpacesAcross } from "../lib/reachable-spaces.ts";
import type { Permission, SpaceGrant } from "../lib/permissions.ts";
import { parseEmptyQuery } from "../lib/list-query.ts";
import { respondRunList } from "./runs.ts";
import { respondScheduleList } from "./schedules.ts";
import { respondFileList } from "./files.ts";
import { respondAgentIndex } from "./agents.ts";
import { respondPackageIndex } from "./packages.ts";

/**
 * The package indexes served across spaces besides the agents' own, each with
 * its `GET /api/packages/{segment}` path segment — spelled out so the route
 * table reads as literals, and checked against `PACKAGE_TYPE_ROUTE_SEGMENT`.
 */
const INDEXED_PACKAGE_TYPES = [
  { type: "skill", segment: "skills" },
  { type: "integration", segment: "integrations" },
] as const satisfies readonly {
  [T in PackageType]: { type: T; segment: (typeof PACKAGE_TYPE_ROUTE_SEGMENT)[T] };
}[PackageType][];

/**
 * The handlers of one list spanning the spaces of `:orgId`. `permissions`
 * (any one admits) is both the ceiling a delegated credential must name — a
 * 403, not an empty page — and the per-space grant that keeps a space: that
 * grant list IS the authorization. The spaces resolve before `list` reads the
 * query, so a refused end-user is a 403 whatever its query.
 */
function readAcrossSpaces(
  permissions: readonly Permission[],
  list: (c: Context<AppEnv>, orgId: string, grants: SpaceGrant[]) => Promise<Response>,
) {
  return [
    requireOrgPathMembership,
    requireAnyCeiling(permissions),
    async (c: Context<AppEnv>) => {
      const orgId = c.req.param("orgId")!;
      return list(c, orgId, await readableSpacesAcross(c, orgId, permissions));
    },
  ] as const;
}

/** An index whose single-space twin reads no query: the org route still refuses one. */
const withEmptyQuery =
  (list: (c: Context<AppEnv>, orgId: string, grants: SpaceGrant[]) => Promise<Response>) =>
  (c: Context<AppEnv>, orgId: string, grants: SpaceGrant[]) => {
    parseEmptyQuery(c);
    return list(c, orgId, grants);
  };

export function createCrossSpaceReadsRouter() {
  const router = new Hono<AppEnv>();

  router.get("/:orgId/runs", ...readAcrossSpaces(RUNS_READ_PERMISSIONS, respondRunList));
  router.get("/:orgId/schedules", ...readAcrossSpaces(["schedules:read"], respondScheduleList));
  router.get("/:orgId/files", rateLimit(120), ...readAcrossSpaces(["files:read"], respondFileList));
  router.get(
    "/:orgId/agents",
    ...readAcrossSpaces(packageSightPermissions("agent"), withEmptyQuery(respondAgentIndex)),
  );

  for (const { type, segment } of INDEXED_PACKAGE_TYPES) {
    router.get(
      `/:orgId/packages/${segment}`,
      ...readAcrossSpaces(
        [packagePermission(type, "read")],
        withEmptyQuery((c, orgId, grants) =>
          respondPackageIndex(
            c,
            type,
            orgId,
            grants.map((g) => g.spaceId),
          ),
        ),
      ),
    );
  }

  return router;
}
