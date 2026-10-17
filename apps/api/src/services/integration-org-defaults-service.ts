// SPDX-License-Identifier: Apache-2.0

/**
 * Default connection set per (space, integration) — a space rule despite the
 * `org_default` name — admin CRUD + the resolver-facing aggregator.
 *
 * The default is the cross-agent governance baseline: one row covers every
 * agent that consumes the integration, instead of one `integration_pins`
 * row per agent. `enforce` discriminates strength (see the table doc in
 * `packages/db/src/schema/integration-org-defaults.ts` and the resolver
 * cascade in `integration-connection-resolver.ts`).
 *
 * Same target validation as admin pins (`validatePinTargets`, shared-only):
 * the connection must serve this space, reference this integration, and be
 * shared into this space — an admin can't coerce a member's personal connection.
 *
 * An enforced default is always closed to additions, so it cannot coexist with an
 * admin pin open to them on the same (space, integration): whichever write would
 * make the pair is refused with 409 `connection_additions_conflict`.
 *
 * Deleting an enforced default, or writing it back soft, removes the floor it imposed: the
 * schedules strictly narrowing it are disabled in the same transaction
 * (`disableSchedulesSelectingWithin`, `schedules-named-by-layer.ts`).
 *
 * An enforced default admits no addition, so it follows the closed admin pin's rule: a member pin
 * never survives under it. Every write or delete where the default IS enforced (after) or WAS
 * enforced (before) deletes, in its transaction, every member pin of the (space, integration)
 * (`purgeMemberPins`; a closed admin pin left none, and the enforced default closes an open one) —
 * masked, none comes back unasked as the member's selection once the default is soft or gone.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationOrgDefaults } from "@appstrate/db/schema";
import type { IntegrationOrgDefault } from "@appstrate/shared-types";
import type { SpaceScope } from "../lib/scope.ts";
import type { Tx } from "../lib/db-helpers.ts";
import { conflict } from "../lib/errors.ts";
import {
  listOpenAdminPinAgents,
  lockIntegrationGovernance,
  purgeMemberPins,
  validatePinTargets,
  type PurgedMemberPin,
} from "./integration-pins-service.ts";
import {
  disableSchedulesSelectingWithin,
  removeNamingLayer,
  schedulesLayerMayName,
  type NamingLayer,
} from "./schedules-named-by-layer.ts";

/** Identical wire shape to {@link IntegrationOrgDefault}; aliased for the canonical pattern (cf. `PinSummary`). */
type OrgDefaultSummary = IntegrationOrgDefault;

export interface OrgDefaultPick {
  connectionIds: string[];
  enforce: boolean;
}

interface UpsertOrgDefaultInput {
  connectionIds: string[];
  enforce: boolean;
}

function toSummary(row: typeof integrationOrgDefaults.$inferSelect): OrgDefaultSummary {
  return {
    integration_package_id: row.integrationId,
    connection_ids: row.connectionIds,
    enforce: row.enforce,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The org default for (space, integration), or null when unset. */
export async function getOrgDefault(
  scope: SpaceScope,
  integrationId: string,
): Promise<OrgDefaultSummary | null> {
  const [row] = await db
    .select()
    .from(integrationOrgDefaults)
    .where(orgDefaultKey(scope, integrationId))
    .limit(1);
  return row ? toSummary(row) : null;
}

/**
 * Resolver-facing map for one space: integrationId → {connectionIds,
 * enforce}. Loaded alongside pins in `resolveConnectionsForRun`.
 */
export async function listOrgDefaultsForResolver(
  spaceId: string,
): Promise<Record<string, OrgDefaultPick>> {
  const rows = await db
    .select({
      integrationId: integrationOrgDefaults.integrationId,
      connectionIds: integrationOrgDefaults.connectionIds,
      enforce: integrationOrgDefaults.enforce,
    })
    .from(integrationOrgDefaults)
    .where(eq(integrationOrgDefaults.spaceId, spaceId));
  return Object.fromEntries(
    rows.map((r) => [r.integrationId, { connectionIds: r.connectionIds, enforce: r.enforce }]),
  );
}

/**
 * Whether the space enforces a default for the integration, read on `tx` — the one read of it the
 * governance writers make, behind `lockIntegrationGovernance`.
 */
export async function isDefaultEnforced(
  tx: Tx,
  scope: SpaceScope,
  integrationId: string,
): Promise<boolean> {
  const [enforced] = await tx
    .select({ id: integrationOrgDefaults.id })
    .from(integrationOrgDefaults)
    .where(and(orgDefaultKey(scope, integrationId), eq(integrationOrgDefaults.enforce, true)))
    .limit(1);
  return enforced !== undefined;
}

function orgDefaultLayer(scope: SpaceScope, integrationId: string): NamingLayer {
  return { kind: "org_default", spaceId: scope.spaceId, integrationId };
}

function orgDefaultKey(scope: SpaceScope, integrationId: string) {
  return and(
    eq(integrationOrgDefaults.spaceId, scope.spaceId),
    eq(integrationOrgDefaults.integrationId, integrationId),
  );
}

/**
 * Set or replace the org default for (space, integration); `previous` is the one it replaced.
 * Enforcing it is refused while an admin pin of the integration is open to additions. The check and
 * the write are one transaction behind the lock the admin pin upsert takes too
 * ({@link lockIntegrationGovernance}), so a concurrent pin write cannot slip an open pin in between;
 * every statement runs on `tx` (PGlite has one connection: a query on `db` would wait on this very
 * transaction). A write where the default is, or was, enforced purges the member pins it masks
 * (`memberPinsCleared`); the default still names every schedule, so none is left unnamed. Writing an
 * enforced default back soft disables the schedules strictly narrowing the floor it imposed, in the
 * same transaction; which schedules may resolve the integration is read before it opens, as for a
 * removal (`removeNamingLayer`), and only when the default read before it was enforced.
 */
export async function upsertOrgDefault(
  scope: SpaceScope,
  integrationId: string,
  input: UpsertOrgDefaultInput,
): Promise<{
  previous: OrgDefaultSummary | null;
  orgDefault: OrgDefaultSummary;
  memberPinsCleared: PurgedMemberPin[];
  disabledScheduleIds: string[];
}> {
  await validatePinTargets(scope, integrationId, input.connectionIds);
  // Only un-enforcing removes a floor, so only then are the candidates worth reading.
  const unenforcing = !input.enforce && (await getOrgDefault(scope, integrationId))?.enforce;
  const mayName = unenforcing
    ? await schedulesLayerMayName(orgDefaultLayer(scope, integrationId))
    : [];
  const now = new Date();
  return db.transaction(async (tx) => {
    await lockIntegrationGovernance(tx, scope.spaceId, integrationId);
    if (input.enforce) await assertNoOpenAdminPin(tx, scope, integrationId);
    const [previous] = await tx
      .select()
      .from(integrationOrgDefaults)
      .where(orgDefaultKey(scope, integrationId))
      .limit(1);
    // Atomic upsert on the (space, integration) unique index: two concurrent first writers cannot
    // have the loser's INSERT throw a raw unique violation.
    const [row] = await tx
      .insert(integrationOrgDefaults)
      .values({
        spaceId: scope.spaceId,
        integrationId,
        connectionIds: input.connectionIds,
        enforce: input.enforce,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [integrationOrgDefaults.spaceId, integrationOrgDefaults.integrationId],
        set: {
          connectionIds: input.connectionIds,
          enforce: input.enforce,
          updatedAt: now,
        },
      })
      .returning();
    const memberPinsCleared =
      previous?.enforce || input.enforce
        ? await purgeMemberPins(tx, scope, integrationId, null)
        : [];
    // Enforced here, soft when the candidates were read: none to judge — an accepted race.
    const disabledScheduleIds =
      previous?.enforce && !input.enforce
        ? await disableSchedulesSelectingWithin(tx, integrationId, mayName, previous.connectionIds)
        : [];
    return {
      previous: previous ? toSummary(previous) : null,
      orgDefault: toSummary(row!),
      memberPinsCleared,
      disabledScheduleIds,
    };
  });
}

/**
 * 409 `connection_additions_conflict` naming every agent ACTIVE here whose admin pin is open to
 * additions ({@link listOpenAdminPinAgents}).
 */
async function assertNoOpenAdminPin(
  tx: Tx,
  scope: SpaceScope,
  integrationId: string,
): Promise<void> {
  const open = await listOpenAdminPinAgents(tx, scope, integrationId);
  if (open.length === 0) return;
  const agents = open.map((id) => `'${id}'`).join(", ");
  const pins =
    open.length === 1 ? `the admin pin of ${agents} lets` : `the admin pins of ${agents} let`;
  throw conflict(
    "connection_additions_conflict",
    `The default connection set of '${integrationId}' cannot be enforced while ${pins} members add connections: an enforced default is always closed. Close them to additions first.`,
  );
}

/**
 * Delete the org default and disable the schedules that leaves unnamed, and, for an enforced one,
 * those strictly narrowing the floor it imposed ({@link removeNamingLayer}); `previous` is the one
 * removed, `null` when none was set. Deleting an enforced default purges the member pins it masked
 * ({@link purgeMemberPins}) inside the removal, before the schedules are judged: a schedule that
 * relied on one is disabled as unnamed with the rest. `memberPinsCleared` is `[]` for a soft one.
 */
export async function deleteOrgDefault(
  scope: SpaceScope,
  integrationId: string,
): Promise<{
  previous: OrgDefaultSummary | null;
  memberPinsCleared: PurgedMemberPin[];
  disabledScheduleIds: string[];
}> {
  const removed = await removeNamingLayer(orgDefaultLayer(scope, integrationId), async (tx) => {
    await lockIntegrationGovernance(tx, scope.spaceId, integrationId);
    const [row] = await tx
      .delete(integrationOrgDefaults)
      .where(orgDefaultKey(scope, integrationId))
      .returning();
    if (!row) return { previous: null };
    const memberPinsCleared = row.enforce
      ? await purgeMemberPins(tx, scope, integrationId, null)
      : [];
    return {
      previous: { orgDefault: toSummary(row), memberPinsCleared },
      removedFloor: row.enforce ? row.connectionIds : null,
    };
  });
  return {
    previous: removed.previous?.orgDefault ?? null,
    memberPinsCleared: removed.previous?.memberPinsCleared ?? [],
    disabledScheduleIds: removed.disabledScheduleIds,
  };
}
