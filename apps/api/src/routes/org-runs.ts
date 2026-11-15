// SPDX-License-Identifier: Apache-2.0

/** The runs of every space of one organization the caller reads runs in: read-only. */

import { Hono } from "hono";
import { canReadRuns } from "@appstrate/core/permissions";
import type { AppEnv } from "../types/index.ts";
import { requireOrgPathMembership } from "../middleware/org-path-context.ts";
import { listGlobalRuns } from "../services/state/runs.ts";
import { callerReachableSpaces } from "../lib/reachable-spaces.ts";
import { runReadGrant } from "../lib/run-visibility.ts";
import { getActor } from "../lib/actor.ts";
import { forbidden, invalidRequest } from "../lib/errors.ts";
import { setOffsetLinkHeader } from "../lib/pagination-link.ts";
import { parseGlobalRunListQuery } from "./runs.ts";

export function createOrgRunsRouter() {
  const router = new Hono<AppEnv>();

  // No space is entered here, so a space-level guard could never pass: the
  // authorization IS the per-space grant list, read from the caller's role in
  // each space they reach (a pinned credential reaches its space only).
  router.get("/:orgId/runs", requireOrgPathMembership, async (c) => {
    // An end-user acts in its own space only (RBAC spec §7.2).
    if (c.get("principalKind") === "end_user") {
      throw forbidden("An end-user cannot list runs across spaces");
    }
    const orgId = c.req.param("orgId")!;
    const filters = parseGlobalRunListQuery(c);
    const reachable = await callerReachableSpaces(c, orgId);
    // Comma-separated like `status`. One answer for a space that does not
    // exist and one the caller does not reach, so the 400 discloses nothing.
    // An empty value reads as absent, as on every closed-set filter.
    const raw = c.req.query("spaceId");
    const requested = raw ? raw.split(",").map((id) => id.trim()) : undefined;
    const unknown = requested?.find((id) => !reachable.some((space) => space.id === id));
    if (unknown !== undefined) {
      throw invalidRequest(`spaceId names a space you do not reach: ${unknown}`, "spaceId");
    }
    const grants = reachable
      .filter((space) => !requested || requested.includes(space.id))
      .filter((space) => canReadRuns((p) => space.permissions.has(p)))
      .map((space) => runReadGrant(space.id, space.permissions));
    const result = await listGlobalRuns(orgId, grants, { ...filters, actor: getActor(c) });
    setOffsetLinkHeader({ c, limit: filters.limit, offset: filters.offset, total: result.total });
    return c.json(result);
  });

  return router;
}
