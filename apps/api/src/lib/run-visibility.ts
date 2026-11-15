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
 * One semantic, five shapes: the read-all test itself; per-space grants and
 * the WHERE fragment over them, for the queries listing one space or several;
 * the one-space WHERE fragment, `undefined` when nothing narrows; an
 * ownership test for a loaded row; and the assertion that turns it into the
 * 404 a handler throws. Nothing re-derives ownership on its own.
 */

import type { Context } from "hono";
import { and, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Actor } from "@appstrate/connect";
import { RUNS_READ_PERMISSIONS } from "@appstrate/core/permissions";
import { runs } from "@appstrate/db/schema";
import { actorFilter, getActor } from "./actor.ts";
import { notFound } from "./errors.ts";
import { readsAgentContent } from "./package-access.ts";
import { callerPermissions } from "./permissions.ts";
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

/** Which runs of ONE space the caller reads: all of them, or their own. */
export interface RunReach {
  spaceId: string;
  readAll: boolean;
}

/**
 * What the caller reads of ONE space's runs, from their effective set there: a
 * run list spanning spaces decides each row by its own space, never by the
 * request's. `agentInput` is {@link readsAgentContent} there.
 */
export interface RunReadGrant extends RunReach {
  agentInput: boolean;
}

export function runReadGrant(spaceId: string, permissions: ReadonlySet<string>): RunReadGrant {
  return {
    spaceId,
    readAll: canReadEveryRun(permissions),
    agentInput: readsAgentContent(permissions),
  };
}

/** The guard on every surface `runs:read` opens, built from the tuple
 *  `canReadRuns` tests — one spelling of the disjunction, not two. */
export const requireRunsRead = requireAnyPermission(RUNS_READ_PERMISSIONS);

/** The in-memory twin of `actorFilter` on a loaded run row: did this principal launch it? */
export function ownsRun(
  actor: Actor,
  row: { userId: string | null; endUserId: string | null },
): boolean {
  return actor.type === "end_user" ? row.endUserId === actor.id : row.userId === actor.id;
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
 * WHERE fragment for the runs `grants` open: every run of a space read in full,
 * the actor's own elsewhere — or everywhere when `ownOnly` (`?user=me`). No
 * grant (or no actor where one is needed), no row. The many-space twin of
 * {@link runVisibilityFilter}: every query spanning spaces narrows through it.
 */
export function runReadCondition(
  grants: readonly RunReach[],
  actor: Actor | null,
  ownOnly = false,
): SQL {
  const everyRun = grants.filter((g) => g.readAll && !ownOnly).map((g) => g.spaceId);
  const ownRuns = grants.filter((g) => !g.readAll || ownOnly).map((g) => g.spaceId);
  const reach: SQL[] = [];
  if (everyRun.length) reach.push(inArray(runs.spaceId, everyRun));
  if (ownRuns.length && actor) {
    reach.push(and(inArray(runs.spaceId, ownRuns), ownRunsFilter(actor))!);
  }
  return or(...reach) ?? sql`false`;
}

/**
 * WHERE fragment narrowing `runs` to what `actor` may read with `permissions`,
 * its effective set in one space; `undefined` = no narrowing.
 */
export function runVisibilityIn(permissions: ReadonlySet<string>, actor: Actor): SQL | undefined {
  return canReadEveryRun(permissions) ? undefined : ownRunsFilter(actor);
}

/** {@link runVisibilityIn} for the request's own space. */
export function runVisibilityFilter(c: Context<AppEnv>): SQL | undefined {
  return runVisibilityIn(callerPermissions(c), getActor(c));
}

/**
 * Refuse a run the caller may not read. Hidden means 404, never 403 — a 403
 * would confirm the run exists.
 */
export function assertRunVisible(
  c: Context<AppEnv>,
  row: { userId: string | null; endUserId: string | null },
): void {
  if (canReadEveryRun(callerPermissions(c))) return;
  if (!ownsRun(getActor(c), row)) throw notFound("Run not found");
}
