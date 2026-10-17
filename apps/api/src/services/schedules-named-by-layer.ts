// SPDX-License-Identifier: Apache-2.0

/**
 * Schedules a cascade layer names an integration's connection set for, and the disable that
 * removing the layer applies to the ones it leaves unnamed: an unattended run never falls back to
 * another account, however many connections its actor holds. Re-enabling goes through the schedule
 * write rule (`schedule-connections.ts`). Which fired versions resolve a set for the integration
 * is the resolver's answer, read before the removal's transaction opens (the resolver reads outside
 * any); every layer fact is read from rows, inside it.
 *
 * Removing an imposed FLOOR (an admin pin, an enforced org default, or the enforcement itself) also
 * disables the schedules whose own selection strictly narrows it ({@link withinFloor}): under the
 * floor it meant "no addition", ungoverned it would bind as written — fewer connections, or none
 * for `[]`. A selection naming the whole floor binds the same either way and is left alone.
 */

import { and, asc, eq, inArray, isNull, notExists, or, sql, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  integrationOrgDefaults,
  integrationPins,
  schedules,
  type ScheduleDisabledReason,
} from "@appstrate/db/schema";
import type { DbOrTx, Tx } from "../lib/db-helpers.ts";
import { ApiError } from "../lib/errors.ts";
import type { LoadedPackage } from "../types/index.ts";
import { resolveAgentRunVersion } from "./agent-version-resolver.ts";
import { integrationsResolvedForRun } from "./integration-connection-resolver.ts";
import { getPackage } from "./package-catalog.ts";
import { seedPinnedIntegrationManifests } from "./run-pipeline.ts";
import { disableSchedules } from "./schedules-naming-connection.ts";

/** A layer naming `integrationId`'s set in a space: its org default, or a pin on one agent. */
export type NamingLayer = { spaceId: string; integrationId: string } & (
  | { kind: "org_default" }
  | { kind: "admin_pin"; agentPackageId: string }
  | { kind: "member_pin"; agentPackageId: string; userId: string }
);

/** A pin as a layer: the admin's for `userId: null`, else that member's. */
export function pinLayer(
  pin: { spaceId: string; agentPackageId: string; integrationId: string },
  userId: string | null,
): NamingLayer {
  const { spaceId, agentPackageId, integrationId } = pin;
  return userId === null
    ? { kind: "admin_pin", spaceId, integrationId, agentPackageId }
    : { kind: "member_pin", spaceId, integrationId, agentPackageId, userId };
}

type ScheduleRow = typeof schedules.$inferSelect;

/** `layer`'s own row among the pins, `undefined` for an org default; `orgDefaultOf` mirrors it. */
function pinOf(layer: NamingLayer): SQL | undefined {
  if (layer.kind === "org_default") return undefined;
  return and(
    eq(integrationPins.spaceId, layer.spaceId),
    eq(integrationPins.packageId, layer.agentPackageId),
    eq(integrationPins.integrationId, layer.integrationId),
    layer.kind === "admin_pin"
      ? isNull(integrationPins.userId)
      : eq(integrationPins.userId, layer.userId),
  );
}

function orgDefaultOf(layer: NamingLayer): SQL | undefined {
  if (layer.kind !== "org_default") return undefined;
  return and(
    eq(integrationOrgDefaults.spaceId, layer.spaceId),
    eq(integrationOrgDefaults.integrationId, layer.integrationId),
  );
}

/** `connection_overrides` holds no key for `integrationId`: a key names its set, `[]` included. */
function noOverrideKey(integrationId: string): SQL {
  return sql`NOT coalesce(${schedules.connectionOverrides} ? ${integrationId}, false)`;
}

/**
 * Nothing but `layer`'s own row names its integration's set for a schedule: it is enabled, with no
 * key in `connection_overrides`, no admin pin or pin of its actor on its agent, no org default.
 */
function leftUnnamed(layer: NamingLayer): SQL | undefined {
  const besides = (own: SQL | undefined) => own && sql`(${own}) IS NOT TRUE`;
  return and(
    eq(schedules.enabled, true),
    noOverrideKey(layer.integrationId),
    notExists(
      db
        .select({ one: sql`1` })
        .from(integrationPins)
        .where(
          and(
            eq(integrationPins.spaceId, schedules.spaceId),
            eq(integrationPins.packageId, schedules.packageId),
            eq(integrationPins.integrationId, layer.integrationId),
            or(isNull(integrationPins.userId), eq(integrationPins.userId, schedules.userId)),
            besides(pinOf(layer)),
          ),
        ),
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(integrationOrgDefaults)
        .where(
          and(
            eq(integrationOrgDefaults.spaceId, schedules.spaceId),
            eq(integrationOrgDefaults.integrationId, layer.integrationId),
            besides(orgDefaultOf(layer)),
          ),
        ),
    ),
  );
}

async function unnamedAmong(
  executor: DbOrTx,
  layer: NamingLayer,
  scheduleIds: readonly string[],
): Promise<string[]> {
  if (scheduleIds.length === 0) return [];
  const rows = await executor
    .select({ id: schedules.id })
    .from(schedules)
    .where(and(inArray(schedules.id, [...scheduleIds]), leftUnnamed(layer)));
  return rows.map((row) => row.id);
}

/** The definition `schedule` fires, or `null` when none resolves: that fire fails on its own. */
async function firedDefinition(schedule: ScheduleRow): Promise<LoadedPackage | null> {
  const draft = await getPackage(schedule.packageId, schedule.orgId);
  if (!draft) return null;
  try {
    return (await resolveAgentRunVersion(draft, schedule.versionOverride ?? undefined)).agent;
  } catch (err) {
    if (err instanceof ApiError) return null;
    throw err;
  }
}

/** The integrations `schedule`'s fire resolves a set for, under its `dependency_overrides`. */
async function integrationsFired(schedule: ScheduleRow): Promise<string[]> {
  const agent = await firedDefinition(schedule);
  if (!agent) return [];
  const { orgId, dependencyOverrides } = schedule;
  return integrationsResolvedForRun(
    agent.manifest as Record<string, unknown>,
    await seedPinnedIntegrationManifests({ agent, orgId, dependencyOverrides }),
  );
}

/**
 * The schedules of `layer`'s scope, enabled or not, whose fire resolves a set for its integration
 * ({@link integrationsFired}). It asks no layer fact: the layer may hold no row.
 */
export async function schedulesLayerMayName(layer: NamingLayer): Promise<string[]> {
  const candidates = await db
    .select()
    .from(schedules)
    .where(
      and(
        eq(schedules.spaceId, layer.spaceId),
        layer.kind === "org_default" ? undefined : eq(schedules.packageId, layer.agentPackageId),
        layer.kind === "member_pin" ? eq(schedules.userId, layer.userId) : undefined,
      ),
    );
  const fired = new Map<string, string[]>();
  const using: string[] = [];
  for (const schedule of candidates) {
    const { packageId, versionOverride, dependencyOverrides } = schedule;
    const fire = JSON.stringify([packageId, versionOverride, dependencyOverrides]);
    if (!fired.has(fire)) fired.set(fire, await integrationsFired(schedule));
    if (fired.get(fire)!.includes(layer.integrationId)) using.push(schedule.id);
  }
  return using;
}

/** The schedules removing `layer` would disable, read while it stands. */
export async function schedulesLeftUnnamedWithout(layer: NamingLayer): Promise<string[]> {
  return unnamedAmong(db, layer, await schedulesLayerMayName(layer));
}

/**
 * Disable, with `reason`, those of `scheduleIds` ({@link schedulesLayerMayName}) that `layer`,
 * gone from `tx`, leaves unnamed. Returns them, whose jobs the caller removes once committed.
 */
export async function disableSchedulesLeftUnnamed(
  tx: Tx,
  layer: NamingLayer,
  scheduleIds: readonly string[],
  reason: ScheduleDisabledReason,
): Promise<string[]> {
  if (scheduleIds.length === 0) return [];
  // Locked, then read by a second statement: under READ COMMITTED only a statement that starts
  // once the locks are granted sees the commit of a concurrent removal it waited on.
  await tx
    .select({ id: schedules.id })
    .from(schedules)
    .where(inArray(schedules.id, [...scheduleIds]))
    .orderBy(asc(schedules.id))
    .for("update");
  const ids = await unnamedAmong(tx, layer, scheduleIds);
  await disableSchedules(tx, ids, reason);
  return ids;
}

/**
 * `selection` strictly narrows `floor`: every id of it is one of the floor's, and it names fewer
 * than the floor holds (`[]` under a non-empty floor does). Under that floor it added nothing;
 * ungoverned it would bind fewer connections than the floor did, or none. An equal set, in any
 * order or case, binds the same either way, so it is not within; nothing is within an empty floor.
 * Uuids compare case-insensitively and deduplicated, as Postgres compares them — the predicate of
 * the `0048` pre-flight report.
 */
export function withinFloor(selection: readonly string[], floor: readonly string[]): boolean {
  const imposed = new Set(floor.map((id) => id.toLowerCase()));
  const chosen = new Set(selection.map((id) => id.toLowerCase()));
  return chosen.size < imposed.size && [...chosen].every((id) => imposed.has(id));
}

/** No admin pin on the schedule's agent and no enforced org default governs `integrationId`. */
function leftUngoverned(integrationId: string): SQL {
  return and(
    notExists(
      db
        .select({ one: sql`1` })
        .from(integrationPins)
        .where(
          and(
            eq(integrationPins.spaceId, schedules.spaceId),
            eq(integrationPins.packageId, schedules.packageId),
            eq(integrationPins.integrationId, integrationId),
            isNull(integrationPins.userId),
          ),
        ),
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(integrationOrgDefaults)
        .where(
          and(
            eq(integrationOrgDefaults.spaceId, schedules.spaceId),
            eq(integrationOrgDefaults.integrationId, integrationId),
            eq(integrationOrgDefaults.enforce, true),
          ),
        ),
    ),
  )!;
}

/**
 * Disable, with `connection_set_unnamed`, those of `scheduleIds` ({@link schedulesLayerMayName})
 * that `floor`, no longer imposed in `tx`, leaves ungoverned while their `connection_overrides` set
 * for its integration strictly narrows it ({@link withinFloor}). Returns them, whose jobs the
 * caller removes once committed.
 */
export async function disableSchedulesSelectingWithin(
  tx: Tx,
  integrationId: string,
  scheduleIds: readonly string[],
  floor: readonly string[],
): Promise<string[]> {
  if (scheduleIds.length === 0) return [];
  // Locked, then read by a second statement: see disableSchedulesLeftUnnamed.
  await tx
    .select({ id: schedules.id })
    .from(schedules)
    .where(inArray(schedules.id, [...scheduleIds]))
    .orderBy(asc(schedules.id))
    .for("update");
  const rows = await tx
    .select({ id: schedules.id, connectionOverrides: schedules.connectionOverrides })
    .from(schedules)
    .where(
      and(
        inArray(schedules.id, [...scheduleIds]),
        eq(schedules.enabled, true),
        leftUngoverned(integrationId),
      ),
    );
  const ids = rows
    .filter((row) => {
      const selection = row.connectionOverrides?.[integrationId];
      return selection !== undefined && withinFloor(selection, floor);
    })
    .map((row) => row.id);
  await disableSchedules(tx, ids, "connection_set_unnamed");
  return ids;
}

/**
 * Remove `layer` with `remove`; when it held a row, disable the schedules that leaves unnamed, and,
 * when that row imposed a floor (`removedFloor`), those selecting within it
 * ({@link disableSchedulesSelectingWithin}).
 */
export async function removeNamingLayer<P>(
  layer: NamingLayer,
  remove: (tx: Tx) => Promise<{ previous: P | null; removedFloor?: readonly string[] | null }>,
): Promise<{ previous: P | null; disabledScheduleIds: string[] }> {
  const mayName = await schedulesLayerMayName(layer);
  return db.transaction(async (tx) => {
    const { previous, removedFloor } = await remove(tx);
    if (previous === null) return { previous, disabledScheduleIds: [] };
    const unnamed = await disableSchedulesLeftUnnamed(tx, layer, mayName, "connection_set_unnamed");
    const selectingWithin = removedFloor
      ? await disableSchedulesSelectingWithin(tx, layer.integrationId, mayName, removedFloor)
      : [];
    return { previous, disabledScheduleIds: [...unnamed, ...selectingWithin] };
  });
}
