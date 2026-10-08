// SPDX-License-Identifier: Apache-2.0

/**
 * Schedules whose `connection_overrides` name a connection, and the disable that losing it applies
 * to the ones another actor armed: never refused, never shrunk to the survivors — the overrides
 * stay as written and re-enabling makes that actor choose again.
 *
 * Every writer that locks several schedules locks them in id order, in one statement: a schedule
 * one transaction holds as its own is another's foreign one.
 */

import { asc, inArray, or, sql, type SQL } from "drizzle-orm";
import { schedules, type ScheduleDisabledReason } from "@appstrate/db/schema";
import type { ConnectionOverrides } from "@appstrate/core/integration";
import type { Actor } from "../lib/actor.ts";
import type { Tx } from "../lib/db-helpers.ts";

/** `connection_overrides` names `connectionId` (a jsonpath variable, never spliced). */
export function scheduleOverridesName(connectionId: string): SQL {
  return sql`jsonb_path_exists(
    ${schedules.connectionOverrides}, '$.*[*] ? (@ == $id)', jsonb_build_object('id', ${connectionId}::text)
  )`;
}

/** A connection and the actor owning it. */
interface OwnedConnection {
  id: string;
  owner: Actor;
}

/** The columns {@link isForeignNaming} judges a schedule on. */
interface NamingSchedule {
  userId: string | null;
  endUserId: string | null;
  enabled: boolean;
  connectionOverrides: ConnectionOverrides | null;
}

/** The schedule's actor is `actor`; the column `actor` does not use is NULL on its schedules. */
export function scheduleActorIs(schedule: NamingSchedule, actor: Actor): boolean {
  return (actor.type === "end_user" ? schedule.endUserId : schedule.userId) === actor.id;
}

/** An enabled schedule naming `connection` whose actor is not the connection's owner. */
export function isForeignNaming(schedule: NamingSchedule, connection: OwnedConnection): boolean {
  return (
    schedule.enabled &&
    !scheduleActorIs(schedule, connection.owner) &&
    Object.values(schedule.connectionOverrides ?? {}).some((ids) => ids.includes(connection.id))
  );
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
 * Disable, with `reason`, the schedules {@link isForeignNaming} one of `connections`; returns
 * their ids, whose jobs the caller removes once committed. Every schedule naming one is locked,
 * with those `alsoLock` matches, in one id-ordered statement, for a caller that writes those next.
 */
export async function disableForeignSchedules(
  tx: Tx,
  connections: readonly OwnedConnection[],
  reason: ScheduleDisabledReason,
  alsoLock?: SQL,
): Promise<string[]> {
  const naming = or(...connections.map((c) => scheduleOverridesName(c.id)));
  if (!naming && !alsoLock) return [];
  const rows = await tx
    .select({
      id: schedules.id,
      userId: schedules.userId,
      endUserId: schedules.endUserId,
      enabled: schedules.enabled,
      connectionOverrides: schedules.connectionOverrides,
    })
    .from(schedules)
    .where(or(naming, alsoLock))
    .orderBy(asc(schedules.id))
    .for("update");
  const ids = rows
    .filter((row) => connections.some((c) => isForeignNaming(row, c)))
    .map((row) => row.id);
  await disableSchedules(tx, ids, reason);
  return ids;
}
