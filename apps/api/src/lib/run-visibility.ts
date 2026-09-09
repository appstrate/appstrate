// SPDX-License-Identifier: Apache-2.0

/**
 * Which runs a principal may read (RBAC spec §3.4).
 *
 * `runs:read` is ownership: the runs the caller launched, including the runs
 * of the caller's own schedules (a schedule carries its frozen actor, so its
 * runs are attributed to it). `runs:read-all` widens that to the whole space
 * — other members' runs, end-users' runs, and the actor-less rows older launch
 * paths left behind.
 *
 * The narrowing predicate is `actorFilter`, never `actorScopeFilter`: the
 * latter's `user_id IS NULL` arm matches every end-user's run for a member
 * actor, which is precisely the supervision `read-all` exists to gate.
 *
 * One semantic, three shapes — a WHERE fragment for the queries that list, an
 * ownership test for a loaded row, and the assertion that turns it into the
 * 404 a handler throws. Nothing re-derives ownership on its own.
 */

import type { Context } from "hono";
import type { SQL } from "drizzle-orm";
import type { Actor } from "@appstrate/connect";
import { runs } from "@appstrate/db/schema";
import { actorFilter, getActor } from "./actor.ts";
import { notFound } from "./errors.ts";
import type { AppEnv } from "../types/index.ts";

/** The in-memory twin of `actorFilter` on a loaded run row: did this principal launch it? */
export function ownsRun(
  actor: Actor,
  row: { userId: string | null; endUserId: string | null },
): boolean {
  return actor.type === "end_user" ? row.endUserId === actor.id : row.userId === actor.id;
}

/** WHERE fragment narrowing `runs` to what the caller may read; `undefined` = no narrowing. */
export function runVisibilityFilter(c: Context<AppEnv>): SQL | undefined {
  if (c.get("permissions")?.has("runs:read-all")) return undefined;
  return actorFilter(getActor(c), { userId: runs.userId, endUserId: runs.endUserId });
}

/**
 * Refuse a run the caller may not read. Hidden means 404, never 403 — a 403
 * would confirm the run exists.
 */
export function assertRunVisible(
  c: Context<AppEnv>,
  row: { userId: string | null; endUserId: string | null },
): void {
  if (c.get("permissions")?.has("runs:read-all")) return;
  if (!ownsRun(getActor(c), row)) throw notFound("Run not found");
}
