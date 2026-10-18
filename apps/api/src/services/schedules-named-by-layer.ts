// SPDX-License-Identifier: Apache-2.0

/**
 * Schedules a cascade layer names an integration's connection set for, and the disable that
 * removing the layer applies to the ones it leaves unnamed: an unattended run never falls back to
 * another account, however many connections its actor holds. Re-enabling goes through the schedule
 * write rule (`schedule-connections.ts`). Which fired versions resolve a set for the integration
 * is the resolver's answer, read on the removal's transaction along with every layer fact.
 * Every armed schedule write takes `lockIntegrationGovernance` for the integrations its judgment
 * relied on and re-checks
 * that governance (`assertScheduleGovernanceUnchanged`), and every removal takes it first: a write
 * either commits before the removal's read (found there), or re-checks
 * after it (refused).
 *
 * Removing an imposed FLOOR (an admin pin, an enforced org default, or the enforcement itself) also
 * disables the schedules whose selection strictly narrows it ({@link withinFloor}): under the floor
 * it meant "no addition", ungoverned it would bind fewer connections, or none. Those are read
 * inside the removal's transaction, behind `lockIntegrationGovernance`: a key in
 * `connection_overrides` is a selection, no resolver needed, and a write storing one re-checks
 * behind the same lock.
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
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { fetchIntegrationManifest } from "./integration-service.ts";

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

/** `connection_overrides` holds a key for `integrationId`: a key names its set, `[]` included. */
function hasOverrideKey(integrationId: string): SQL {
  return sql`coalesce(${schedules.connectionOverrides} ? ${integrationId}, false)`;
}

function noOverrideKey(integrationId: string): SQL {
  return sql`NOT ${hasOverrideKey(integrationId)}`;
}

/** The schedules of `layer`'s scope: its space, and its agent (and member) for a pin. */
function inLayerScope(layer: NamingLayer): SQL | undefined {
  return and(
    eq(schedules.spaceId, layer.spaceId),
    layer.kind === "org_default" ? undefined : eq(schedules.packageId, layer.agentPackageId),
    layer.kind === "member_pin" ? eq(schedules.userId, layer.userId) : undefined,
  );
}

/**
 * No layer names the enabled schedule's set. Only a preview excludes the layer it simulates
 * removing; mutation checks count every layer currently present.
 */
function leftUnnamed(layer: NamingLayer, excludeOwnLayer = false): SQL | undefined {
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
            excludeOwnLayer ? besides(pinOf(layer)) : undefined,
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
            excludeOwnLayer ? besides(orgDefaultOf(layer)) : undefined,
          ),
        ),
    ),
  );
}

async function unnamedAmong(
  executor: DbOrTx,
  layer: NamingLayer,
  scheduleIds: readonly string[],
  excludeOwnLayer = false,
): Promise<string[]> {
  if (scheduleIds.length === 0) return [];
  const rows = await executor
    .select({ id: schedules.id })
    .from(schedules)
    .where(
      and(
        inArray(schedules.id, [...scheduleIds]),
        inLayerScope(layer),
        leftUnnamed(layer, excludeOwnLayer),
      ),
    );
  return rows.map((row) => row.id);
}

/** The definition `schedule` fires, or `null` when none resolves: that fire fails on its own. */
async function firedDefinition(
  schedule: ScheduleRow,
  executor: DbOrTx,
): Promise<LoadedPackage | null> {
  const draft = await getPackage(schedule.packageId, schedule.orgId, { executor });
  if (!draft) return null;
  try {
    return (await resolveAgentRunVersion(draft, schedule.versionOverride ?? undefined, executor))
      .agent;
  } catch (err) {
    if (err instanceof ApiError) return null;
    throw err;
  }
}

/** The integrations `schedule`'s fire resolves a set for, under its `dependency_overrides`. */
async function integrationsFired(schedule: ScheduleRow, executor: DbOrTx): Promise<string[]> {
  const agent = await firedDefinition(schedule, executor);
  if (!agent) return [];
  const { orgId, dependencyOverrides } = schedule;
  const manifestCache = await seedPinnedIntegrationManifests({
    agent,
    orgId,
    dependencyOverrides,
    executor,
  });
  // Soft/unresolved dependencies fall back to their draft: seed those on the same transaction too.
  for (const entry of parseManifestIntegrations(agent.manifest)) {
    await fetchIntegrationManifest(entry.id, manifestCache, executor);
  }
  return integrationsResolvedForRun(agent.manifest as Record<string, unknown>, manifestCache);
}

/**
 * The schedules of `layer`'s scope, enabled or not, whose fire resolves a set for its integration
 * ({@link integrationsFired}). It asks no layer fact: the layer may hold no row.
 */
export async function schedulesLayerMayName(
  layer: NamingLayer,
  executor: DbOrTx = db,
): Promise<string[]> {
  const candidates = await executor.select().from(schedules).where(inLayerScope(layer));
  const fired = new Map<string, string[]>();
  const using: string[] = [];
  for (const schedule of candidates) {
    const { packageId, versionOverride, dependencyOverrides } = schedule;
    const fire = JSON.stringify([packageId, versionOverride, dependencyOverrides]);
    if (!fired.has(fire)) fired.set(fire, await integrationsFired(schedule, executor));
    if (fired.get(fire)!.includes(layer.integrationId)) using.push(schedule.id);
  }
  return using;
}

/** The schedules removing `layer` would disable, read while it stands. */
export async function schedulesLeftUnnamedWithout(layer: NamingLayer): Promise<string[]> {
  return unnamedAmong(db, layer, await schedulesLayerMayName(layer), true);
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
 * `selection` strictly narrows `floor`: only floor ids, fewer than the floor holds (`[]` under a
 * non-empty floor included). An equal set, in any order, binds the same governed or not, so it is
 * not within; nothing is within an empty floor. Uuids are lowercased and deduplicated, as Postgres
 * compares them.
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
 * Disable, with `connection_set_unnamed`, the enabled schedules of `layer`'s scope left ungoverned
 * in `tx` whose `connection_overrides` set for its integration strictly narrows the removed
 * `floor`. Read here, on `tx`, behind the caller's `lockIntegrationGovernance`, never from a read
 * made before the transaction: a schedule written in between would keep a selection whose meaning
 * the removal changed. Returns them, whose jobs the caller removes once committed.
 */
export async function disableSchedulesSelectingWithin(
  tx: Tx,
  layer: NamingLayer,
  floor: readonly string[],
): Promise<string[]> {
  if (floor.length === 0) return [];
  const selecting = and(inLayerScope(layer), hasOverrideKey(layer.integrationId));
  // Locked, then read by a second statement: see disableSchedulesLeftUnnamed.
  await tx
    .select({ id: schedules.id })
    .from(schedules)
    .where(selecting)
    .orderBy(asc(schedules.id))
    .for("update");
  const rows = await tx
    .select({ id: schedules.id, connectionOverrides: schedules.connectionOverrides })
    .from(schedules)
    .where(and(selecting, eq(schedules.enabled, true), leftUngoverned(layer.integrationId)));
  const ids = rows
    .filter((row) => {
      const selection = row.connectionOverrides?.[layer.integrationId];
      return selection !== undefined && withinFloor(selection, floor);
    })
    .map((row) => row.id);
  await disableSchedules(tx, ids, "connection_set_unnamed");
  return ids;
}

/**
 * Remove `layer` with `remove` (`previous: null` when there was no row); when there was one, disable
 * the schedules that leaves unnamed, and those selecting within the floor it imposed, if any.
 * The caller takes the governance lock first. Resolution and disabling share its transaction:
 * a failure rolls back the removal, and a recreated layer cannot race a post-commit cleanup.
 */
export async function removeNamingLayer<
  R extends { previous: unknown; removedFloor?: readonly string[] | null },
>(
  layer: NamingLayer,
  remove: (tx: Tx) => Promise<R>,
): Promise<R & { disabledScheduleIds: string[] }> {
  return db.transaction(async (tx) => {
    const removed = await remove(tx);
    if (removed.previous === null) return { ...removed, disabledScheduleIds: [] };
    const mayName = await schedulesLayerMayName(layer, tx);
    const unnamed = await disableSchedulesLeftUnnamed(tx, layer, mayName, "connection_set_unnamed");
    const selectingWithin = removed.removedFloor
      ? await disableSchedulesSelectingWithin(tx, layer, removed.removedFloor)
      : [];
    return { ...removed, disabledScheduleIds: [...unnamed, ...selectingWithin] };
  });
}
