// SPDX-License-Identifier: Apache-2.0

/**
 * Which runs a principal may read (RBAC spec §3.4).
 *
 * `runs:read` is ownership: the runs the caller launched, including the runs
 * of the caller's own schedules (a schedule carries its frozen actor, so its
 * runs are attributed to it). `runs:read-all` widens that to the whole space
 * — other members' runs, end-users' runs, and rows with no actor at all (both
 * columns NULL — no live launch path writes one).
 *
 * The narrowing predicate is `actorFilter`, never `actorScopeFilter`: the
 * latter's `user_id IS NULL` arm matches every end-user's run for a member
 * actor, which is precisely the supervision `read-all` exists to gate.
 *
 * A published file copies its run's attribution (`runs-events.ts`,
 * `getRunAttribution`), so the file row and the run row answer the same
 * ownership question — which is why the file surfaces test whichever of the
 * two they already have loaded rather than joining back to the other.
 *
 * One semantic, four shapes — the read-all test itself, a WHERE fragment for
 * the queries that list, an ownership test for a loaded row, and the assertion
 * that turns it into the 404 a handler throws. Nothing re-derives ownership on
 * its own.
 */

import type { Context } from "hono";
import { and, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Actor } from "@appstrate/connect";
import { RUNS_READ_PERMISSIONS } from "@appstrate/core/permissions";
import { runs } from "@appstrate/db/schema";
import { actorFilter, getActor } from "./actor.ts";
import { notFound } from "./errors.ts";
import { callerPermissions, type SpaceGrant } from "./permissions.ts";
import { requireAnyPermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../types/index.ts";

/**
 * Does this principal read the whole space's runs? Named for the question, not
 * for the permission string, so the SSE auth result's `canReadEveryRun` and the
 * subscriber filter's `readAll` each keep the name their own neighbours gave
 * them (`canReadDebugLogs`, `isAdmin`) while asking this one predicate.
 */
export function canReadEveryRun(permissions: ReadonlySet<string>): boolean {
  return permissions.has("runs:read-all");
}

/** The guard on every surface `runs:read` opens, built from the tuple
 *  `canReadRuns` tests — one spelling of the disjunction, not two. */
export const requireRunsRead = requireAnyPermission(RUNS_READ_PERMISSIONS);

/** The in-memory twin of `actorFilter` on a loaded run row: did this principal launch it? */
function ownsRun(actor: Actor, row: { userId: string | null; endUserId: string | null }): boolean {
  return actor.type === "end_user" ? row.endUserId === actor.id : row.userId === actor.id;
}

/** Whether a caller holding `permissions` in a run's space reads that loaded run. */
export function readsRun(
  permissions: ReadonlySet<string>,
  actor: Actor,
  row: { userId: string | null; endUserId: string | null },
): boolean {
  return canReadEveryRun(permissions) || ownsRun(actor, row);
}

/**
 * WHERE fragment for the runs this principal launched — the narrow half of
 * {@link runVisibilityFilter}, and on its own what `GET /api/runs?user=me`
 * means. "Mine" is one predicate whether it comes from the permission or from
 * the query parameter, so a caller holding `read-all` who asks for `user=me`
 * reads exactly the rows a plain `runs:read` caller reads.
 */
function ownRunsFilter(actor: Actor): SQL {
  return actorFilter(actor, { userId: runs.userId, endUserId: runs.endUserId });
}

/**
 * WHERE fragment for the runs `grants` open: every run of a space whose grant
 * reads them all ({@link canReadEveryRun}), the actor's own elsewhere — or
 * everywhere when `ownOnly` (`?user=me`). No grant (or no actor where one is
 * needed), no row. The many-space twin of {@link runVisibilityFilter}: every
 * query spanning spaces narrows through it.
 */
export function runReadCondition(
  grants: readonly SpaceGrant[],
  actor: Actor | null,
  ownOnly = false,
): SQL {
  const readAll = (g: SpaceGrant) => !ownOnly && canReadEveryRun(g.permissions);
  const everyRun = grants.filter(readAll).map((g) => g.spaceId);
  const ownRuns = grants.filter((g) => !readAll(g)).map((g) => g.spaceId);
  const reach: SQL[] = [];
  if (everyRun.length) reach.push(inArray(runs.spaceId, everyRun));
  if (ownRuns.length && actor) {
    reach.push(and(inArray(runs.spaceId, ownRuns), ownRunsFilter(actor))!);
  }
  return or(...reach) ?? sql`false`;
}

/** WHERE fragment narrowing `runs` to what the caller may read; `undefined` = no narrowing. */
export function runVisibilityFilter(c: Context<AppEnv>): SQL | undefined {
  if (canReadEveryRun(callerPermissions(c))) return undefined;
  return ownRunsFilter(getActor(c));
}

/**
 * Refuse a run the caller may not read. Hidden means 404, never 403 — a 403
 * would confirm the run exists.
 */
export function assertRunVisible(
  c: Context<AppEnv>,
  row: { userId: string | null; endUserId: string | null },
): void {
  if (!readsRun(callerPermissions(c), getActor(c), row)) throw notFound("Run not found");
}
