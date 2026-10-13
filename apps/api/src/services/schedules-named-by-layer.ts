// SPDX-License-Identifier: Apache-2.0

/**
 * Schedules a cascade layer names an integration's connection set for, and the disable that
 * removing the layer applies to the ones it leaves unnamed: an enabled schedule names its set, and
 * an unattended run never falls back to another account. Re-enabling goes through the schedule
 * write rule (`schedule-connections.ts`).
 *
 * The verdict never counts the actor's connections: which layer bound a fire is the resolver's
 * answer, and what still names the set afterwards is read from rows.
 */

import { and, asc, eq, exists, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  integrationOrgDefaults,
  integrationPins,
  schedules,
  type ScheduleDisabledReason,
} from "@appstrate/db/schema";
import type { ConnectionResolutionSource } from "@appstrate/core/integration";
import { actorFromIds } from "../lib/actor.ts";
import type { Tx } from "../lib/db-helpers.ts";
import { ApiError } from "../lib/errors.ts";
import type { LoadedPackage } from "../types/index.ts";
import { resolveAgentRunVersion } from "./agent-version-resolver.ts";
import { resolveConnectionsForRun, toLaunchOverrides } from "./integration-connection-resolver.ts";
import { getPackage } from "./package-catalog.ts";
import { seedPinnedIntegrationManifests } from "./run-pipeline.ts";
import { disableSchedules } from "./schedules-naming-connection.ts";

/** A layer naming `integrationId`'s set in a space: its org default, or a pin on one agent. */
type NamingLayer = { spaceId: string; integrationId: string } & (
  | { kind: "org_default" }
  | { kind: "admin_pin"; agentPackageId: string }
  | { kind: "member_pin"; agentPackageId: string; userId: string }
);

/** The sources the resolver reports for a layer: an org default's carries its strength. */
const LAYER_SOURCES: Record<NamingLayer["kind"], readonly ConnectionResolutionSource[]> = {
  org_default: ["org_default", "org_default_enforced"],
  admin_pin: ["admin_pin"],
  member_pin: ["member_pin"],
};

type ScheduleRow = typeof schedules.$inferSelect;

/** The layer's own row. */
function layerRow(layer: NamingLayer) {
  if (layer.kind === "org_default") {
    return db
      .select({ one: sql`1` })
      .from(integrationOrgDefaults)
      .where(
        and(
          eq(integrationOrgDefaults.spaceId, layer.spaceId),
          eq(integrationOrgDefaults.integrationId, layer.integrationId),
        ),
      );
  }
  return db
    .select({ one: sql`1` })
    .from(integrationPins)
    .where(
      and(
        eq(integrationPins.spaceId, layer.spaceId),
        eq(integrationPins.packageId, layer.agentPackageId),
        eq(integrationPins.integrationId, layer.integrationId),
        layer.kind === "admin_pin"
          ? isNull(integrationPins.userId)
          : eq(integrationPins.userId, layer.userId),
      ),
    );
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

/** Whether the resolver, called as `schedule`'s fire calls it, decides through `layer`. */
async function fireBindsThrough(
  schedule: ScheduleRow,
  agent: LoadedPackage,
  layer: NamingLayer,
): Promise<boolean> {
  const { resolved, errors, warnings } = await resolveConnectionsForRun({
    agentManifest: agent.manifest as Record<string, unknown>,
    packageId: agent.id,
    // `package_schedules_exactly_one_actor` guarantees exactly one of the two ids.
    actor: actorFromIds(schedule.userId, schedule.endUserId)!,
    scope: { orgId: schedule.orgId, spaceId: schedule.spaceId },
    launchOverrides: toLaunchOverrides(schedule.connectionOverrides, "schedule_override"),
    manifestCache: await seedPinnedIntegrationManifests({
      agent,
      orgId: schedule.orgId,
      dependencyOverrides: schedule.dependencyOverrides,
    }),
  });
  const about = (item: { integrationId: string }) => item.integrationId === layer.integrationId;
  const source =
    resolved[layer.integrationId]?.[0]?.source ??
    errors.find(about)?.source ??
    warnings.find(about)?.source;
  return source !== undefined && LAYER_SOURCES[layer.kind].includes(source);
}

/**
 * The enabled schedules whose fire binds `layer`'s integration through `layer`, read while the
 * layer stands; none when it has no row. An integration the fired version does not declare or
 * leaves inert, or the space has switched off, is decided through no layer.
 */
export async function schedulesBoundThrough(layer: NamingLayer): Promise<string[]> {
  const candidates = await db
    .select()
    .from(schedules)
    .where(
      and(
        eq(schedules.enabled, true),
        eq(schedules.spaceId, layer.spaceId),
        layer.kind === "org_default" ? undefined : eq(schedules.packageId, layer.agentPackageId),
        layer.kind === "member_pin" ? eq(schedules.userId, layer.userId) : undefined,
        exists(layerRow(layer)),
      ),
    );
  const definitions = new Map<string, LoadedPackage | null>();
  const bound: string[] = [];
  for (const schedule of candidates) {
    const version = `${schedule.packageId}@${schedule.versionOverride ?? ""}`;
    if (!definitions.has(version)) definitions.set(version, await firedDefinition(schedule));
    const agent = definitions.get(version);
    if (agent && (await fireBindsThrough(schedule, agent, layer))) bound.push(schedule.id);
  }
  return bound;
}

/**
 * Disable, with `reason`, those of `scheduleIds` nothing names `layer`'s integration for once the
 * layer is gone from `tx`: still enabled, no key in `connection_overrides` (`[]` is a name), no
 * admin pin or pin of its actor on its agent, no org default. Locked in one id-ordered statement
 * (`schedules-naming-connection.ts`); returns them, whose jobs the caller removes once committed.
 */
export async function disableSchedulesLeftUnnamed(
  tx: Tx,
  layer: NamingLayer,
  scheduleIds: readonly string[],
  reason: ScheduleDisabledReason,
): Promise<string[]> {
  if (scheduleIds.length === 0) return [];
  const rows = await tx
    .select({ id: schedules.id })
    .from(schedules)
    .where(
      and(
        inArray(schedules.id, [...scheduleIds]),
        eq(schedules.enabled, true),
        sql`NOT coalesce(${schedules.connectionOverrides} ? ${layer.integrationId}, false)`,
        notExists(
          tx
            .select({ one: sql`1` })
            .from(integrationPins)
            .where(
              and(
                eq(integrationPins.spaceId, schedules.spaceId),
                eq(integrationPins.packageId, schedules.packageId),
                eq(integrationPins.integrationId, layer.integrationId),
                or(isNull(integrationPins.userId), eq(integrationPins.userId, schedules.userId)),
              ),
            ),
        ),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(integrationOrgDefaults)
            .where(
              and(
                eq(integrationOrgDefaults.spaceId, schedules.spaceId),
                eq(integrationOrgDefaults.integrationId, layer.integrationId),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(schedules.id))
    .for("update");
  const ids = rows.map((row) => row.id);
  await disableSchedules(tx, ids, reason);
  return ids;
}

/**
 * Remove `layer` with `remove` and, when it held a row, disable the schedules that leaves unnamed
 * (`connection_set_unnamed`), in one transaction. Their fires are read before it opens: the
 * resolver reads outside any transaction.
 */
export async function removeNamingLayer<P>(
  layer: NamingLayer,
  remove: (tx: Tx) => Promise<{ previous: P | null }>,
): Promise<{ previous: P | null; disabledScheduleIds: string[] }> {
  const bound = await schedulesBoundThrough(layer);
  return db.transaction(async (tx) => {
    const { previous } = await remove(tx);
    const disabledScheduleIds =
      previous === null
        ? []
        : await disableSchedulesLeftUnnamed(tx, layer, bound, "connection_set_unnamed");
    return { previous, disabledScheduleIds };
  });
}
