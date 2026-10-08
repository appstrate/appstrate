// SPDX-License-Identifier: Apache-2.0

/**
 * Schedules whose `connection_overrides` name a connection, and the disable that losing it applies
 * to the ones another actor armed: never refused, never shrunk to the survivors — the overrides
 * stay as written and re-enabling makes that actor choose again.
 */

import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { schedules, type ScheduleDisabledReason } from "@appstrate/db/schema";
import type { Actor } from "../lib/actor.ts";
import type { DbOrTx, Tx } from "../lib/db-helpers.ts";

/** `connection_overrides` names `connectionId` (a jsonpath variable, never spliced). */
export function scheduleOverridesName(connectionId: string): SQL {
  return sql`jsonb_path_exists(
    ${schedules.connectionOverrides}, '$.*[*] ? (@ == $id)', jsonb_build_object('id', ${connectionId}::text)
  )`;
}

/** A connection and the actor owning it. */
export interface OwnedConnection {
  id: string;
  owner: Actor;
}

/** Null-safe: the actor column `owner` does not use is NULL on every schedule it armed. */
function notArmedBy(owner: Actor): SQL {
  const column = owner.type === "end_user" ? schedules.endUserId : schedules.userId;
  return sql`${column} IS DISTINCT FROM ${owner.id}`;
}

/**
 * The enabled schedules naming one of `connections` that its owner did not arm, in id order. No
 * space predicate: an enabled schedule may still name a connection of another space (a re-enable
 * whose fired version does not resolve skips the reach check).
 */
export function foreignSchedulesNaming(
  executor: DbOrTx,
  connections: readonly OwnedConnection[],
  filter?: SQL,
) {
  const naming = connections.map((c) => and(scheduleOverridesName(c.id), notArmedBy(c.owner)));
  return executor
    .select({ id: schedules.id })
    .from(schedules)
    .where(and(eq(schedules.enabled, true), or(...naming) ?? sql`false`, filter))
    .orderBy(asc(schedules.id));
}

/** The `updated_at` bump fails the compare-and-set of a PATCH read before it. */
export async function disableSchedules(
  tx: Tx,
  ids: readonly string[],
  reason: ScheduleDisabledReason,
): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(schedules)
    .set({ enabled: false, disabledReason: reason, nextRunAt: null, updatedAt: new Date() })
    .where(inArray(schedules.id, [...ids]));
}

/**
 * Disable {@link foreignSchedulesNaming} `connections`, locked; returns their ids, whose jobs the
 * caller removes once committed.
 */
export async function disableForeignSchedules(
  tx: Tx,
  connections: readonly OwnedConnection[],
  reason: ScheduleDisabledReason,
): Promise<string[]> {
  if (connections.length === 0) return [];
  const rows = await foreignSchedulesNaming(tx, connections).for("update");
  const ids = rows.map((row) => row.id);
  await disableSchedules(tx, ids, reason);
  return ids;
}
