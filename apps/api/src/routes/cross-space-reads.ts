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
import { listGlobalRuns } from "../services/state/runs.ts";
import { listSchedules } from "../services/scheduler.ts";
import { listFilesForActor } from "../services/files.ts";
import { listAgentIndex, listPackageIndex } from "../services/package-index.ts";
import { readableSpacesAcross } from "../lib/reachable-spaces.ts";
import { fileLifecycleCeiling, type Permission, type SpaceGrant } from "../lib/permissions.ts";
import { getActor } from "../lib/actor.ts";
import { listResponse } from "@appstrate/core/list-query";
import { assertKnownQuery } from "../lib/list-query.ts";
import { setCursorLinkHeader } from "../lib/pagination-link.ts";
import { parseGlobalRunListQuery, RUN_LIST_QUERY_PARAMETERS } from "../lib/run-list-query.ts";
import { parseListFilesQuery } from "../lib/file-list-query.ts";
import { packageAccessSpaces } from "../lib/package-access.ts";

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
 * The handlers of one list spanning the spaces of `:orgId`, its read
 * permission stated once, as `permissions` (any one of them admits): the
 * ceiling guard refuses a delegated credential whose scopes omit them all
 * instead of answering it an empty page, and the reach keeps the spaces whose
 * effective set grants one. No space is entered here, so a space-level guard
 * could never pass: the authorization IS that per-space grant list. The spaces
 * are resolved before any parameter is read, so a refused end-user is a 403
 * whatever its query; then a query parameter outside `query` is a 400 (`null`:
 * the list's own parser is strict).
 */
function readAcrossSpaces(
  permissions: readonly Permission[],
  query: readonly string[] | null,
  list: (c: Context<AppEnv>, orgId: string, grants: SpaceGrant[]) => Promise<Response>,
) {
  return [
    requireOrgPathMembership,
    requireAnyCeiling(permissions),
    async (c: Context<AppEnv>) => {
      const orgId = c.req.param("orgId")!;
      const grants = await readableSpacesAcross(c, orgId, permissions);
      if (query) assertKnownQuery(c, query);
      return list(c, orgId, grants);
    },
  ] as const;
}

export function createCrossSpaceReadsRouter() {
  const router = new Hono<AppEnv>();

  router.get(
    "/:orgId/runs",
    ...readAcrossSpaces(
      RUNS_READ_PERMISSIONS,
      RUN_LIST_QUERY_PARAMETERS,
      async (c, orgId, grants) => {
        const filters = parseGlobalRunListQuery(c);
        const result = await listGlobalRuns(orgId, grants, { ...filters, actor: getActor(c) });
        setCursorLinkHeader({ c, hasMore: result.hasMore, lastId: result.data.at(-1)?.id });
        return c.json(result);
      },
    ),
  );

  router.get(
    "/:orgId/schedules",
    ...readAcrossSpaces(["schedules:read"], [], async (c, orgId, grants) =>
      c.json(listResponse(await listSchedules(orgId, grants, getActor(c)))),
    ),
  );

  router.get(
    "/:orgId/files",
    rateLimit(120),
    ...readAcrossSpaces(["files:read"], null, async (c, orgId, grants) =>
      c.json(
        await listFilesForActor(
          orgId,
          grants,
          getActor(c),
          parseListFilesQuery(c),
          fileLifecycleCeiling(c),
        ),
      ),
    ),
  );

  router.get(
    "/:orgId/agents",
    ...readAcrossSpaces(packageSightPermissions("agent"), [], async (c, orgId, grants) =>
      c.json(
        listResponse(
          await listAgentIndex(orgId, grants, getActor(c), await packageAccessSpaces(c)),
        ),
      ),
    ),
  );

  for (const { type, segment } of INDEXED_PACKAGE_TYPES) {
    router.get(
      `/:orgId/packages/${segment}`,
      ...readAcrossSpaces([packagePermission(type, "read")], [], async (c, orgId, grants) =>
        c.json(
          listResponse(
            await listPackageIndex(
              type,
              orgId,
              grants.map((g) => g.spaceId),
              await packageAccessSpaces(c),
            ),
          ),
        ),
      ),
    );
  }

  return router;
}
