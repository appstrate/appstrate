// SPDX-License-Identifier: Apache-2.0

/**
 * Schedules whose `connection_overrides` name a connection, and the disable that losing it applies
 * to the ones another actor armed: never refused, never shrunk to the survivors — the overrides
 * stay as written and re-enabling makes that actor choose again.
 *
 * Every explicit writer that locks several schedules locks them in id order, in one statement: a
 * schedule one transaction holds as its own is another's foreign one. A cascade delete (agent,
 * space, end user) locks in the order it walks; a deadlock with one is detected by Postgres.
 */

import { nextScheduleVersion } from "../lib/schedule-version.ts";
import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { schedules, type ScheduleDisabledReason } from "@appstrate/db/schema";
import type { ConnectionOverrides } from "@appstrate/core/integration";
import type { Actor } from "../lib/actor.ts";
import type { DbOrTx, Tx } from "../lib/db-helpers.ts";

/** `connection_overrides` names `connectionId` (a jsonpath variable, never spliced). */
export function scheduleOverridesName(connectionId: string): SQL {
  return sql`jsonb_path_exists(
    ${schedules.connectionOverrides}, '$.*[*] ? (@ == $id)', jsonb_build_object('id', ${connectionId}::text)
  )`;
}

/** `connection_overrides` names one of `connectionIds`; `undefined` for none. */
export function schedulesNamingAny(connectionIds: readonly string[]): SQL | undefined {
  return or(...connectionIds.map((id) => scheduleOverridesName(id)));
}

/** The keys of `overrides` naming one of `ownedIds`, in key order. */
export function integrationsNamingAny(
  overrides: ConnectionOverrides | null,
  ownedIds: ReadonlySet<string>,
): string[] {
  return Object.entries(overrides ?? {})
    .filter(([, ids]) => ids.some((id) => ownedIds.has(id)))
    .map(([integrationId]) => integrationId)
    .sort();
}

/** A connection and the actor owning it. */
interface OwnedConnection {
  id: string;
  owner: Actor;
}

/** Lost in `inSpaceId` only, when set: an unshare from one target. */
interface LostConnection extends OwnedConnection {
  inSpaceId?: string;
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

/**
 * Disable `ids` for `reason`: `enabled` off, `next_run_at` cleared, `updated_at` bumped so a PATCH
 * read before fails its compare-and-set. Their jobs are the caller's to remove after the commit.
 */
export async function disableSchedules(
  tx: Tx,
  ids: readonly string[],
  reason: ScheduleDisabledReason,
): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(schedules)
    .set({
      enabled: false,
      disabledReason: reason,
      nextRunAt: null,
      updatedAt: nextScheduleVersion,
    })
    .where(inArray(schedules.id, [...ids]));
}

/** Schedules naming one of `connections` (in its `inSpaceId` when set); `undefined` for none. */
function foreignNamingWhere(connections: readonly LostConnection[]): SQL | undefined {
  return or(
    ...connections.map((c) =>
      and(
        scheduleOverridesName(c.id),
        c.inSpaceId === undefined ? undefined : eq(schedules.spaceId, c.inSpaceId),
      ),
    ),
  );
}

/** The columns {@link pickForeign} reads, in id order. */
const FOREIGN_NAMING_COLUMNS = {
  id: schedules.id,
  spaceId: schedules.spaceId,
  userId: schedules.userId,
  endUserId: schedules.endUserId,
  enabled: schedules.enabled,
  connectionOverrides: schedules.connectionOverrides,
};

/** The ids of `rows` {@link isForeignNaming} one of `connections` (of its `inSpaceId` when set). */
function pickForeign(
  rows: readonly (NamingSchedule & { id: string; spaceId: string })[],
  connections: readonly LostConnection[],
): string[] {
  return rows
    .filter((row) =>
      connections.some(
        (c) =>
          (c.inSpaceId === undefined || row.spaceId === c.inSpaceId) && isForeignNaming(row, c),
      ),
    )
    .map((row) => row.id);
}

/**
 * The schedules {@link disableForeignSchedules} would disable for losing `connections`, read
 * without a lock: a preview, stale as soon as it is returned.
 */
export async function selectForeignNamingScheduleIds(
  executor: DbOrTx,
  connections: readonly LostConnection[],
): Promise<string[]> {
  const naming = foreignNamingWhere(connections);
  if (!naming) return [];
  const rows = await executor
    .select(FOREIGN_NAMING_COLUMNS)
    .from(schedules)
    .where(naming)
    .orderBy(asc(schedules.id));
  return pickForeign(rows, connections);
}

/**
 * Disable, with `reason`, the schedules {@link isForeignNaming} one of `connections` (of its
 * `inSpaceId` when set); returns their ids, whose jobs the caller removes once committed. Every
 * schedule naming one is locked, with the `alsoLock` matches, in one id-ordered statement.
 */
export async function disableForeignSchedules(
  tx: Tx,
  connections: readonly LostConnection[],
  reason: ScheduleDisabledReason,
  alsoLock?: SQL,
): Promise<string[]> {
  const naming = foreignNamingWhere(connections);
  if (!naming && !alsoLock) return [];
  const rows = await tx
    .select(FOREIGN_NAMING_COLUMNS)
    .from(schedules)
    .where(or(naming, alsoLock))
    .orderBy(asc(schedules.id))
    .for("update");
  const ids = pickForeign(rows, connections);
  await disableSchedules(tx, ids, reason);
  return ids;
}
