// SPDX-License-Identifier: Apache-2.0

/**
 * Service layer for `integration_pins` + the per-(space, integration)
 * `block_user_connections` toggle (connection edits live in `connection-shares.ts`).
 * Consumed by the routes in `routes/integrations.ts` and `routes/me.ts`.
 *
 * Pin model (flat): one row per (space, agent, integration, scope), carrying
 * the bound set in `connection_ids` — `[]` pins to no connection, no row is no pin.
 * Scope = admin (`user_id IS NULL`, the imposed floor, optionally open to the run's
 * selection via `allow_additional_connections`) OR member (`user_id = caller.id`, the
 * member's selection, never open). Semantics: `packages/db/src/schema/integration-pins.ts`.
 *
 * All governance operations — the route layer enforces
 * `requirePermission("integrations", "configure")`; this layer assumes the
 * caller already holds it.
 */

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { AuditPayload } from "@appstrate/core/module";
import { db, toRows } from "@appstrate/db/client";
import {
  spacePackages,
  packageShares,
  integrationConnections,
  integrationPins,
  packages,
} from "@appstrate/db/schema";
import type { IntegrationPinRow as PinRow } from "@appstrate/db/schema";
import type {
  AccessibleIntegrationConnection,
  ConsumingAgentSummary,
  IntegrationAgentResolution,
  IntegrationCandidate,
  IntegrationPin,
} from "@appstrate/shared-types";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { activatePackageWithin, isPackageActiveHere, placedRowFilter } from "./space-packages.ts";
import { activeHereSql } from "./package-activation.ts";
import {
  getPackageDisplayName,
  notEphemeralFilter,
  orgOrSystemFilter,
} from "../lib/package-helpers.ts";
import { conflict, notFound } from "../lib/errors.ts";
import type { Tx } from "../lib/db-helpers.ts";
import type { SpaceScope } from "../lib/scope.ts";
import type { ConnectionPrincipal } from "../lib/connection-principal.ts";
import type { ValidationFieldError } from "../lib/errors.ts";
import { getPackage } from "./package-catalog.ts";
import { resolveAgentRunVersion } from "./agent-version-resolver.ts";
import { fetchIntegrationManifest, resolveRunIntegrationVersions } from "./integration-service.ts";
import { getOrgDefault, isDefaultEnforced } from "./integration-org-defaults-service.ts";
import { resolveConnectionOwnerNames } from "./integration-connection-owner-names.ts";
import {
  connectionReach,
  connectionViewOf,
  loadConnectionShares,
  listReachableConnections,
} from "./integration-connections.ts";
import { sharedInSpace, usableInSpace } from "./connection-reach.ts";
import {
  additionsOpen,
  resolveConnectionsForRun,
  translateResolutionError,
  isUserConnectionCreationBlocked,
  requirementOf,
  rankByLeastPrivilege,
  servingCandidates,
} from "./integration-connection-resolver.ts";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import type {
  ConnectionResolutionResult,
  ConnectionResolutionWarning,
  ReadinessErrorCode,
} from "@appstrate/core/integration";
import type { IntegrationManifestCache } from "./integration-service.ts";
import { placementRowJoin, placementShareJoin } from "./package-placement.ts";
import { pinLayer, removeNamingLayer, withinFloor } from "./schedules-named-by-layer.ts";

// Canonical wire shapes live in @appstrate/shared-types so the frontend
// hook and OpenAPI spec can't drift from the service. Local aliases keep
// the existing call sites readable.
type PinSummary = IntegrationPin;

// ─────────────────────────── block_user_connections toggle ────────────────────

/**
 * Toggle the per-(space, integration) lock.
 *
 * An existing `space_packages` row is updated in place — but only where the
 * package is PLACED here ({@link placedRowFilter}), the same conjunct the
 * READER of this flag applies (`isUserConnectionCreationBlocked`). On the bare
 * `(space_id, package_id)` pair this would answer `200 blocked: true` on an
 * ORPHAN row while the gate went on letting every member create a personal
 * connection — a padlock drawn over an open door.
 *
 * With NO row the toggle still has to persist, and the row it needs is a
 * PLACEMENT row — which makes creating it an activation, not a side effect. It
 * goes through the one door that writes them (`activatePackageWithin`), inside
 * this transaction, rather than spelling the INSERT a second time.
 *
 * That door reports whether the package was ALREADY active, and only that case
 * may proceed: an integration `SYSTEM_INTEGRATIONS` offers is active with no
 * row, so materializing one records the flag and changes no verdict — hence no
 * `package.activated` audit and no activation grant. Anything else would be
 * switched ON by the row, and recording a connection lock is not a decision to
 * switch an integration on, so the throw rolls the transaction back. The same
 * door refuses the orphan the UPDATE just skipped: no home, no share, no
 * `shareBy`, its own 404 before the row is touched.
 */
export async function setBlockUserConnections(
  scope: SpaceScope,
  integrationId: string,
  blocked: boolean,
): Promise<{ blocked: boolean }> {
  return db.transaction(async (tx) => {
    const writeFlag = () =>
      tx
        .update(spacePackages)
        .set({ blockUserConnections: blocked, updatedAt: new Date() })
        .where(
          and(
            eq(spacePackages.spaceId, scope.spaceId),
            eq(spacePackages.packageId, integrationId),
            placedRowFilter(tx, scope.spaceId, integrationId),
          ),
        )
        .returning({ blockUserConnections: spacePackages.blockUserConnections });

    const updated = await writeFlag();
    if (updated.length > 0) return { blocked: updated[0]!.blockUserConnections };

    const activation = await activatePackageWithin(tx, scope, integrationId);
    if (!activation.wasActive) {
      throw notFound(`Integration '${integrationId}' is not active in this space`);
    }
    // The door above either found the package placed here or created the
    // share that places it, so this second write matches — an orphan never
    // reaches it.
    const [materialized] = await writeFlag();
    return { blocked: materialized!.blockUserConnections };
  });
}

// ─────────────────────────── Pin CRUD ─────────────────────────────────────────

/** A pin's audit `resourceId`: one format for admin and member rows; `action` tells them apart. */
export function pinAuditResourceId(agentPackageId: string, integrationPackageId: string): string {
  return `${integrationPackageId}#${agentPackageId}`;
}

/** A pin's audited `before`/`after`: its set, or `null` for no row. */
export function pinAudit(connectionIds: string[] | null): AuditPayload | null {
  return connectionIds ? { connectionIds } : null;
}

/** An admin pin's audited state: its floor and whether the run's selection may add to it. */
export function adminPinAudit(
  pin: Pick<PinSummary, "connection_ids" | "allow_additional_connections">,
): AuditPayload {
  return {
    connectionIds: pin.connection_ids,
    allowAdditionalConnections: pin.allow_additional_connections,
  };
}

function toPinSummary(pin: PinRow, agentActive: boolean): PinSummary {
  return {
    agent_package_id: pin.packageId,
    integration_package_id: pin.integrationId,
    connection_ids: pin.connectionIds,
    allow_additional_connections: pin.allowAdditionalConnections,
    agent_active: agentActive,
    createdAt: pin.createdAt.toISOString(),
    updatedAt: pin.updatedAt.toISOString(),
  };
}

/**
 * List every admin pin governing a (space, integration), each with whether its agent is ACTIVE
 * here — the {@link isPackageActiveHere} rule, conjoined on the placement joins: a pin of an agent
 * that runs nowhere still stands, and still names its connections. Used by the admin UI to render
 * the per-agent pin section + by the runtime resolver via the dedicated `loadPins` helper (private
 * to the resolver, see integration-connection-resolver.ts).
 */
export async function listIntegrationPins(
  scope: SpaceScope,
  integrationId: string,
): Promise<PinSummary[]> {
  const active = and(
    orgOrSystemFilter(scope.orgId),
    notEphemeralFilter(),
    activeHereSql(scope.spaceId),
  );
  const rows = await db
    .select({
      pin: integrationPins,
      // No package row (left join): every conjunct is NULL, so not active.
      agentActive: sql<boolean>`coalesce((${active}), false)`.mapWith(Boolean),
    })
    .from(integrationPins)
    .leftJoin(packages, eq(packages.id, integrationPins.packageId))
    .leftJoin(spacePackages, placementRowJoin(packages.id, scope.spaceId))
    .leftJoin(packageShares, placementShareJoin(packages.id, scope.spaceId))
    .where(
      and(
        eq(integrationPins.spaceId, scope.spaceId),
        eq(integrationPins.integrationId, integrationId),
        isNull(integrationPins.userId),
      ),
    )
    .orderBy(integrationPins.packageId);
  return rows.map((row) => toPinSummary(row.pin, row.agentActive));
}

/**
 * R2 — agents this space RUNS that declare the given integration in their
 * dependencies. Powers the centralised pin management table on the
 * integration detail page (so the admin can pick which agent to pin without
 * leaving the integration view).
 *
 * ACTIVE, not "holds a row" ({@link activeHereSql}): a pin names the agent a
 * run will use this connection for, and a deactivated agent — or an ORPHAN
 * row, a decision about a package this space has lost — runs nowhere, so
 * offering it as a pin target would offer a pin that can never fire. Written
 * in the query builder rather than as raw SQL so the rule is CONJOINED here
 * rather than copied.
 */
export async function listAgentsConsumingIntegration(
  scope: SpaceScope,
  integrationId: string,
): Promise<ConsumingAgentSummary[]> {
  const rows = await db
    .select({ id: packages.id, draftManifest: packages.draftManifest })
    .from(packages)
    .leftJoin(spacePackages, placementRowJoin(packages.id, scope.spaceId))
    .leftJoin(packageShares, placementShareJoin(packages.id, scope.spaceId))
    .where(
      and(
        eq(packages.type, "agent"),
        orgOrSystemFilter(scope.orgId),
        notEphemeralFilter(),
        activeHereSql(scope.spaceId),
        sql`(${packages.draftManifest} -> 'dependencies' -> 'integrations') ? ${integrationId}`,
      ),
    )
    .orderBy(packages.id);

  return rows.map((r) => ({
    agent_package_id: r.id,
    display_name: getPackageDisplayName(r),
  }));
}

interface SetPinInput {
  agentPackageId: string;
  connectionIds: string[];
  /** Open the floor to the run's selection; refused over `[]` by the route and the CHECK. */
  allowAdditionalConnections: boolean;
}

/**
 * Replace the admin pin — the floor every run of the agent binds, and whether the run's
 * selection may add to it. Validates that EVERY pinned connection:
 *   1. serves this space,
 *   2. references the integration this pin governs,
 *   3. is shared into this space (pinning a personal connection would
 *      leak the admin's identity to other members at run time).
 * An empty set pins to none; the resolver refuses it where the running version requires the integration.
 *
 * Opening is refused with 409 `connection_additions_conflict` while the space enforces a default
 * for the integration (an enforced default is always closed, and the two would otherwise disagree
 * on what may add). A member pin never survives under a closed admin pin: a write that stores the
 * pin closed, or replaces a closed one, deletes the member pins of its (space, agent, integration)
 * in the same transaction ({@link purgeMemberPins}) — masked by the closed floor, they would
 * otherwise come back as additions or as an ungoverned selection nobody chose again. Only a write
 * where they were live before and stay live after keeps them: none → open, open → open.
 */
export async function upsertIntegrationPin(
  scope: SpaceScope,
  integrationId: string,
  input: SetPinInput,
): Promise<PinWrite> {
  return upsertPin({
    scope,
    agentPackageId: input.agentPackageId,
    integrationId,
    connectionIds: input.connectionIds,
    userIdValue: null,
    allowAdditionalConnections: input.allowAdditionalConnections,
    validateOpts: {},
  });
}

/** A member pin a governance write or delete purged: its owner, its agent and the set it held. */
export interface PurgedMemberPin {
  userId: string;
  agentPackageId: string;
  connectionIds: string[];
}

/** A member pin an admin pin write or delete purged, as its audit records it: the pin's own agent. */
type ClearedMemberPin = Omit<PurgedMemberPin, "agentPackageId">;

/**
 * A pin write: the pin it replaced (`null` when there was none), the stored pin, and the member
 * pins it purged (`[]` for a member pin write and for none → open, open → open).
 */
interface PinWrite {
  previous: PinSummary | null;
  pin: PinSummary;
  memberPinsCleared: ClearedMemberPin[];
}

/** The one pin row of (space, agent, integration, owner) — `userId: null` is the admin pin. */
function pinKey(
  scope: SpaceScope,
  agentPackageId: string,
  integrationId: string,
  userId: string | null,
) {
  return and(
    eq(integrationPins.spaceId, scope.spaceId),
    eq(integrationPins.packageId, agentPackageId),
    eq(integrationPins.integrationId, integrationId),
    userId === null ? isNull(integrationPins.userId) : eq(integrationPins.userId, userId),
  );
}

/**
 * Delete, on `tx`, the member pins of (space, integration) a governance admitting no addition masks
 * — one agent's (the triple an admin pin governs), or, for `agentPackageId: null`, every agent's
 * (around an enforced org default: a closed admin pin left none, an open one is closed by it).
 * Every one, by the rule "a member pin never survives under a closed floor" — or, given the `floor`
 * of an open admin pin being deleted, only those whose set strictly narrows it ({@link withinFloor}):
 * under the floor they added nothing, ungoverned they would bind as written. Returns them by agent
 * then owner, for the audit.
 */
export async function purgeMemberPins(
  tx: Tx,
  scope: SpaceScope,
  integrationId: string,
  agentPackageId: string | null,
  floor?: readonly string[],
): Promise<PurgedMemberPin[]> {
  const reached = and(
    eq(integrationPins.spaceId, scope.spaceId),
    eq(integrationPins.integrationId, integrationId),
    isNotNull(integrationPins.userId),
    agentPackageId === null ? undefined : eq(integrationPins.packageId, agentPackageId),
  );
  const within =
    floor === undefined
      ? undefined
      : (
          await tx
            .select({ id: integrationPins.id, connectionIds: integrationPins.connectionIds })
            .from(integrationPins)
            .where(reached)
        )
          .filter((row) => withinFloor(row.connectionIds, floor))
          .map((row) => row.id);
  if (within?.length === 0) return [];
  const rows = await tx
    .delete(integrationPins)
    .where(and(reached, within ? inArray(integrationPins.id, within) : undefined))
    .returning({
      userId: integrationPins.userId,
      agentPackageId: integrationPins.packageId,
      connectionIds: integrationPins.connectionIds,
    });
  return rows
    .map((row) => ({ ...row, userId: row.userId! }))
    .sort(
      (a, b) =>
        a.agentPackageId.localeCompare(b.agentPackageId) || a.userId.localeCompare(b.userId),
    );
}

/** {@link purgeMemberPins} of one admin pin's triple, as its audit records them. */
async function purgeAdminPinMemberPins(
  tx: Tx,
  scope: SpaceScope,
  agentPackageId: string,
  integrationId: string,
  floor?: readonly string[],
): Promise<ClearedMemberPin[]> {
  const purged = await purgeMemberPins(tx, scope, integrationId, agentPackageId, floor);
  return purged.map(({ userId, connectionIds }) => ({ userId, connectionIds }));
}

/**
 * The agents, active in the space, whose admin pin of `integrationId` is open to additions — the
 * pins an enforced default would contradict. An inactive agent runs nowhere (the resolver closes
 * its additions under an enforced default anyway), so it is no conflict. On `tx`: the caller holds
 * {@link lockIntegrationGovernance}.
 */
export async function listOpenAdminPinAgents(
  tx: Tx,
  scope: SpaceScope,
  integrationId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ agentPackageId: integrationPins.packageId })
    .from(integrationPins)
    .innerJoin(packages, eq(packages.id, integrationPins.packageId))
    .leftJoin(spacePackages, placementRowJoin(packages.id, scope.spaceId))
    .leftJoin(packageShares, placementShareJoin(packages.id, scope.spaceId))
    .where(
      and(
        eq(integrationPins.spaceId, scope.spaceId),
        eq(integrationPins.integrationId, integrationId),
        isNull(integrationPins.userId),
        eq(integrationPins.allowAdditionalConnections, true),
        activeHereSql(scope.spaceId),
      ),
    )
    .orderBy(integrationPins.packageId);
  return rows.map((row) => row.agentPackageId);
}

/**
 * Serialize the writers of a (space, integration)'s governance — the admin pin upsert and delete,
 * the org default upsert and delete, and the member pin upsert — for the rest of the transaction.
 * Each writer checks the OTHER side, or purges the member pins it masks, and then writes its own,
 * and under READ COMMITTED two concurrent writers can both pass the check before either commits;
 * with the lock the second one reads the first's committed rows: refused, or purging the member pin
 * written in between. Taken FIRST, before any read.
 */
export async function lockIntegrationGovernance(
  tx: Tx,
  spaceId: string,
  integrationId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`integration-governance:${spaceId}:${integrationId}`})::bigint)`,
  );
}

/**
 * Raw SQL: `onConflictDoUpdate` cannot target the index's `coalesce`; the
 * returned row goes through drizzle's column mappers (drivers differ). The
 * targets are validated first; the governance read, the write and the purge it
 * implies are one transaction, every statement on `tx`.
 */
async function upsertPin(args: {
  scope: SpaceScope;
  agentPackageId: string;
  integrationId: string;
  connectionIds: string[];
  userIdValue: string | null;
  allowAdditionalConnections: boolean;
  validateOpts: { allowOwnedBy?: string };
}): Promise<PinWrite> {
  const { scope, agentPackageId, integrationId, connectionIds, userIdValue } = args;
  const allow = args.allowAdditionalConnections;
  await assertAgentActiveHere(scope, agentPackageId);

  const ids = sql`ARRAY[${sql.join(
    connectionIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
  await validatePinTargets(scope, integrationId, connectionIds, args.validateOpts);
  return db.transaction(async (tx) => {
    await lockIntegrationGovernance(tx, scope.spaceId, integrationId);
    if (allow) await assertNoEnforcedDefault(tx, scope, agentPackageId, integrationId);
    if (userIdValue !== null) {
      await assertMemberPinBinds(tx, scope, agentPackageId, integrationId, connectionIds);
    }
    const [previousRow] = await tx
      .select()
      .from(integrationPins)
      .where(pinKey(scope, agentPackageId, integrationId, userIdValue))
      .limit(1);
    const [row] = toRows<{
      connection_ids: string | unknown[];
      allow_additional_connections: boolean;
      created_at: string | Date;
      updated_at: string | Date;
    }>(
      await tx.execute(sql`
      INSERT INTO ${integrationPins}
        (space_id, package_id, integration_package_id, user_id, connection_ids, allow_additional_connections)
      VALUES (${scope.spaceId}, ${agentPackageId}, ${integrationId}, ${userIdValue}, ${ids}, ${allow})
      ON CONFLICT (space_id, package_id, integration_package_id, (coalesce(user_id, '')))
      DO UPDATE SET
        connection_ids = EXCLUDED.connection_ids,
        allow_additional_connections = EXCLUDED.allow_additional_connections,
        updated_at = now()
      RETURNING connection_ids, allow_additional_connections, created_at, updated_at
    `),
    );
    // Written closed, or replacing a closed pin: the member pins were, or would be, masked.
    const closedBeforeOrAfter =
      !allow || (previousRow !== undefined && !previousRow.allowAdditionalConnections);
    const memberPinsCleared =
      userIdValue === null && closedBeforeOrAfter
        ? await purgeAdminPinMemberPins(tx, scope, agentPackageId, integrationId)
        : [];
    // A write requires the agent active here (`assertAgentActiveHere`), before and after.
    return {
      previous: previousRow ? toPinSummary(previousRow, true) : null,
      memberPinsCleared,
      pin: {
        agent_package_id: agentPackageId,
        integration_package_id: integrationId,
        connection_ids: integrationPins.connectionIds.mapFromDriverValue(
          row!.connection_ids,
        ) as string[],
        allow_additional_connections: integrationPins.allowAdditionalConnections.mapFromDriverValue(
          row!.allow_additional_connections,
        ) as boolean,
        agent_active: true,
        createdAt: (
          integrationPins.createdAt.mapFromDriverValue(row!.created_at) as Date
        ).toISOString(),
        updatedAt: (
          integrationPins.updatedAt.mapFromDriverValue(row!.updated_at) as Date
        ).toISOString(),
      },
    };
  });
}

/**
 * 409 `connection_additions_conflict` when the space enforces a default for the integration: an
 * enforced default is always closed, so an open admin pin under it would promise additions the
 * resolver never binds.
 */
async function assertNoEnforcedDefault(
  tx: Tx,
  scope: SpaceScope,
  agentPackageId: string,
  integrationId: string,
): Promise<void> {
  if (!(await isDefaultEnforced(tx, scope, integrationId))) return;
  throw conflict(
    "connection_additions_conflict",
    `The admin pin of '${agentPackageId}' cannot let members add connections to '${integrationId}': this space enforces a default connection set for it, and an enforced default is always closed. Stop enforcing the default first.`,
  );
}

/**
 * A member pin is written only where it binds: 409 `connection_additions_blocked` under a governance
 * that admits no addition (an admin pin closed to additions, an enforced org default, or an open pin
 * under one — `!additionsOpen`), where it would only be masked; 409 `connection_set_too_large` under
 * an open admin pin when the floor plus the selection exceeds {@link MAX_CONNECTIONS_PER_INTEGRATION}.
 * Ungoverned, anything goes. Read on `tx`, behind {@link lockIntegrationGovernance}.
 */
async function assertMemberPinBinds(
  tx: Tx,
  scope: SpaceScope,
  agentPackageId: string,
  integrationId: string,
  connectionIds: readonly string[],
): Promise<void> {
  const [adminPin] = await tx
    .select({
      connectionIds: integrationPins.connectionIds,
      allowAdditionalConnections: integrationPins.allowAdditionalConnections,
    })
    .from(integrationPins)
    .where(pinKey(scope, agentPackageId, integrationId, null))
    .limit(1);
  const enforced = await isDefaultEnforced(tx, scope, integrationId);
  if (!adminPin && !enforced) return;
  if (!additionsOpen(adminPin?.allowAdditionalConnections ?? false, enforced)) {
    const governance = adminPin
      ? enforced
        ? "an admin pin the space's enforced default closes to additions"
        : "an admin pin closed to additions"
      : "the space's enforced default";
    throw conflict(
      "connection_additions_blocked",
      `The connections of '${integrationId}' for '${agentPackageId}' are imposed by ${governance}: a member's own selection cannot be added. Ask an admin to change that set.`,
    );
  }
  const floor = adminPin!.connectionIds;
  const union = new Set([...floor, ...connectionIds].map((id) => id.toLowerCase()));
  if (union.size > MAX_CONNECTIONS_PER_INTEGRATION) {
    throw conflict(
      "connection_set_too_large",
      `The admin pin of '${agentPackageId}' imposes ${floor.length} connections of '${integrationId}': with your selection, ${union.size} distinct connections would bind, more than the cap of ${MAX_CONNECTIONS_PER_INTEGRATION}. Pin fewer.`,
    );
  }
}

/**
 * Delete one pin row — the admin pin for `userId: null`, else that member's — and disable the
 * schedules that leaves unnamed ({@link removeNamingLayer}); `previous` is the set it held, `null`
 * when there was none, and `previousAllowedAdditions` whether that row was open to additions
 * (always `false` for a member pin and when there was none).
 *
 * Deleting a CLOSED admin pin purges the member pins of its (space, agent, integration)
 * ({@link purgeMemberPins}) inside the removal, before the schedules are judged: masked until now,
 * they never revive as the member's ungoverned selection, and a schedule that relied on one is
 * disabled as unnamed with the rest. So does deleting an OPEN one while the space enforces a default
 * for the integration: that default governs the agent from now on, and masks them all. Deleting an
 * OPEN admin pin otherwise keeps those that added a connection — live additions until now, they
 * stay the member's selection — and purges those strictly narrowing the floor ({@link withinFloor}),
 * which added nothing and would otherwise bind fewer connections as written. `memberPinsCleared` is
 * `[]` on every other delete. Either way the admin
 * pin's floor is removed, so the schedules of the agent narrowing it are disabled too
 * (`removedFloor`, {@link removeNamingLayer}). An admin pin delete takes
 * {@link lockIntegrationGovernance} first, as every governance writer does.
 */
export async function deletePin(
  scope: SpaceScope,
  agentPackageId: string,
  integrationId: string,
  userId: string | null,
): Promise<{
  previous: string[] | null;
  previousAllowedAdditions: boolean;
  memberPinsCleared: ClearedMemberPin[];
  disabledScheduleIds: string[];
}> {
  const pin = { spaceId: scope.spaceId, agentPackageId, integrationId };
  const removed = await removeNamingLayer(pinLayer(pin, userId), async (tx) => {
    if (userId === null) await lockIntegrationGovernance(tx, scope.spaceId, integrationId);
    const [row] = await tx
      .delete(integrationPins)
      .where(pinKey(scope, agentPackageId, integrationId, userId))
      .returning({
        connectionIds: integrationPins.connectionIds,
        allowAdditionalConnections: integrationPins.allowAdditionalConnections,
      });
    if (!row) return { previous: null };
    if (userId !== null) {
      return { previous: { ...row, memberPinsCleared: [] as ClearedMemberPin[] } };
    }
    // Closed, or open under an enforced default that masks them from now on: every member pin
    // goes. Open and ungoverned after: those strictly narrowing the floor it imposed.
    const keepsAdditions =
      row.allowAdditionalConnections && !(await isDefaultEnforced(tx, scope, integrationId));
    const memberPinsCleared = await purgeAdminPinMemberPins(
      tx,
      scope,
      agentPackageId,
      integrationId,
      keepsAdditions ? row.connectionIds : undefined,
    );
    return { previous: { ...row, memberPinsCleared }, removedFloor: row.connectionIds };
  });
  return {
    previous: removed.previous?.connectionIds ?? null,
    previousAllowedAdditions: removed.previous?.allowAdditionalConnections ?? false,
    memberPinsCleared: removed.previous?.memberPinsCleared ?? [],
    disabledScheduleIds: removed.disabledScheduleIds,
  };
}

/**
 * A pin names the agent a run will resolve this connection FOR, so the
 * question is ACTIVATION and not the presence of a row: a deactivated agent,
 * and an orphan row naming a package this space no longer holds, both run
 * nowhere. {@link isPackageActiveHere} is the ONE rule and carries the org
 * boundary in its own query — which is why the message now matches the check.
 */
async function assertAgentActiveHere(scope: SpaceScope, agentPackageId: string): Promise<void> {
  if (!(await isPackageActiveHere(scope, agentPackageId))) {
    throw notFound(`Agent '${agentPackageId}' is not active in this space`);
  }
}

/**
 * Asserts, in one query, that the caller may pin every one of `connectionIds` for `integrationId`
 * here: rows shared into the space, plus `allowOwnedBy`'s own usable here for a member pin. Every
 * refusal is the SAME 404 naming the first refused id, so a pin write cannot tell a colleague's
 * private uuid from a made-up one.
 */
export async function validatePinTargets(
  scope: SpaceScope,
  integrationId: string,
  connectionIds: string[],
  opts: { allowOwnedBy?: string } = {},
): Promise<void> {
  if (connectionIds.length === 0) return;
  const c = integrationConnections;
  const reachable = await db
    .select({ id: c.id })
    .from(c)
    .where(
      and(
        inArray(c.id, connectionIds),
        eq(c.integrationId, integrationId),
        opts.allowOwnedBy === undefined
          ? sharedInSpace(scope.spaceId)
          : usableInSpace(scope.spaceId, { type: "user", id: opts.allowOwnedBy }),
      ),
    );
  // Postgres compares uuids case-insensitively; the ids it returns are lowercase.
  const found = new Set(reachable.map((r) => r.id));
  const refused = connectionIds.find((id) => !found.has(id.toLowerCase()));
  if (refused === undefined) return;
  const wanted =
    opts.allowOwnedBy === undefined
      ? "a shared connection"
      : "one of your connections or a shared one";
  throw notFound(`Connection '${refused}' is not ${wanted} of ${integrationId} in this space`);
}

// ─────────────────────────── Member-pin CRUD ─────────────────────────────────

interface UpsertMemberPinInput {
  agentPackageId: string;
  integrationId: string;
  connectionIds: string[];
  userId: string;
}

/**
 * Upsert a member-scope pin (`integration_pins` row with `user_id` set).
 *
 * Member writes their own selection for this (agent, integration) — the
 * persisted row the resolver sees on every run: bound as is when nothing
 * governs, added to the floor under an open admin pin. Written only where it
 * binds ({@link assertMemberPinBinds}): under a governance that admits no
 * addition it would be masked, so it is refused, nothing stored. Never open.
 * The set is stored as named, floor ids included (the UI writes additions only).
 * `previous` is the set it replaced (`null` when there was none).
 */
export async function upsertMemberPin(
  scope: SpaceScope,
  input: UpsertMemberPinInput,
): Promise<{ previous: string[] | null; pin: PinSummary }> {
  const { previous, pin } = await upsertPin({
    scope,
    agentPackageId: input.agentPackageId,
    integrationId: input.integrationId,
    connectionIds: input.connectionIds,
    userIdValue: input.userId,
    allowAdditionalConnections: false,
    validateOpts: { allowOwnedBy: input.userId },
  });
  return { previous: previous?.connection_ids ?? null, pin };
}

/**
 * List the caller's own member pins for an agent. Drives the agent-page
 * picker — UI checks "is this integration already pinned by me?" and
 * renders the collapsed "Using: X" row pointing at the pinned connection.
 */
interface MemberPinSummary {
  integration_package_id: string;
  connection_ids: string[];
}

export async function listMemberPinsForAgent(
  scope: SpaceScope,
  agentPackageId: string,
  userId: string,
): Promise<MemberPinSummary[]> {
  return db
    .select({
      integration_package_id: integrationPins.integrationId,
      connection_ids: integrationPins.connectionIds,
    })
    .from(integrationPins)
    .where(
      and(
        eq(integrationPins.spaceId, scope.spaceId),
        eq(integrationPins.packageId, agentPackageId),
        eq(integrationPins.userId, userId),
      ),
    )
    .orderBy(integrationPins.integrationId);
}

// ─────────────────────────── Shared accessor for the picker UI ────────────────

/**
 * List the connections an actor can pick from for a given
 * (space, integration), oldest first. Used by the UI picker:
 * own + shared, with caller-facing labels.
 *
 * The same rows ({@link listReachableConnections} under `usable`) as `listIntegrationConnections` on the
 * settings surface; only the projected DTO differs (this one carries
 * `owner_name` and the split owner ids the picker keys on, the other the
 * full connection summary).
 */
export async function listAccessibleConnections(
  scope: SpaceScope,
  integrationId: string,
  principal: ConnectionPrincipal,
): Promise<AccessibleIntegrationConnection[]> {
  const rows = await listReachableConnections(
    { spaceId: scope.spaceId, actor: principal.actor },
    "usable",
    [integrationId],
  );
  const ownerName = await resolveConnectionOwnerNames(rows);
  const shares = await loadConnectionShares(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row): AccessibleIntegrationConnection => {
    return {
      id: row.id,
      auth_key: row.authKey,
      account_id: row.accountId,
      label: row.label,
      owner_user_id: row.userId,
      owner_end_user_id: row.endUserId,
      owner_name: ownerName(row),
      scopes_granted: row.scopesGranted ?? [],
      ...connectionReach(
        row,
        connectionViewOf(principal, row, scope.spaceId, shares.get(row.id) ?? []),
      ),
      needs_reconnection: row.needsReconnection,
    };
  });
}

// ─────────────────────────── Agent-page picker resolution ─────────────────────

/**
 * The single-source verdict for the agent-page connection picker: which
 * connection the next run would use for this (agent, integration, actor),
 * plus the candidate list and pin/blocked state the dropdown renders.
 *
 * The decision is {@link resolveConnectionsForRun}'s, never re-implemented:
 * `source`, `error_code` and `warning` are its verdict verbatim, and per-candidate
 * `missingScopes` are a display annotation on top.
 *
 * `agentManifest` and `resolution` are REQUIRED and caller-supplied, which is
 * load-bearing rather than stylistic. Loading the package here would read
 * `agent.manifest` — always the DRAFT — while the caller has resolved the
 * manifest for the requested `version`: on `?version=<pinned>` the response
 * would describe the pinned version in `blocks_run` and the draft in every
 * `integrations[].resolution`. Taking both as parameters makes that divergence
 * unrepresentable: there is no manifest in scope here to read the wrong one
 * from. It also avoids an N+1 — one cascade per declared integration, each
 * re-fetching the package and every manifest.
 */
async function resolveAgentIntegrationPick(args: {
  scope: SpaceScope;
  agentPackageId: string;
  integrationId: string;
  principal: ConnectionPrincipal;
  canConnect: boolean;
  canConfigureIntegrations: boolean;
  /** The manifest of the version under inspection — never re-read from the package. */
  agentManifest: Record<string, unknown>;
  /** Agent-level `includeInert: true` cascade, resolved once for every integration. */
  resolution: ConnectionResolutionResult;
  /** The run cascade's warnings: why a run would start without an integration. */
  runWarnings: ConnectionResolutionWarning[];
  /** Agent-level member pins, fetched once. */
  memberPins: MemberPinSummary[];
  /** Shared integration-manifest memo, so N integrations cost N fetches, not N². */
  manifestCache: IntegrationManifestCache;
}): Promise<IntegrationAgentResolution> {
  const {
    scope,
    agentPackageId,
    integrationId,
    principal,
    canConnect,
    canConfigureIntegrations,
    agentManifest,
    resolution,
  } = args;
  const actor = principal.actor;

  const agentEntry = parseManifestIntegrations(agentManifest).find((e) => e.id === integrationId);

  const manifestRes = await fetchIntegrationManifest(integrationId, args.manifestCache);
  const manifest = manifestRes.ok ? manifestRes.manifest : null;

  const memberPins = args.memberPins;

  const [candidatesRaw, adminPins, blocked, orgDefault] = await Promise.all([
    listAccessibleConnections(scope, integrationId, principal),
    listIntegrationPins(scope, integrationId),
    isUserConnectionCreationBlocked(scope.spaceId, integrationId),
    getOrgDefault(scope, integrationId),
  ]);

  // `null` = no pin; `[]` = a pin to no connection.
  const adminPin = adminPins.find((p) => p.agent_package_id === agentPackageId) ?? null;
  const adminPinnedConnectionIds = adminPin?.connection_ids ?? null;
  const memberPinnedConnectionIds =
    memberPins.find((p) => p.integration_package_id === integrationId)?.connection_ids ?? null;

  // The resolver's own candidate universe (orphaned-auth guard, the dep's pinned
  // `auth_key`, auths serving the selection), so the picker offers exactly the
  // `must_choose_connection` candidates. No manifest → no verdict to align with.
  const requirement = manifest && agentEntry ? requirementOf(agentEntry, manifest) : null;
  const candidateRows = requirement
    ? servingCandidates(requirement, candidatesRaw, (c) => c.auth_key)
    : candidatesRaw;
  const scoped = candidateRows.map((c) => ({
    c,
    authKey: c.auth_key,
    scopesGranted: c.scopes_granted,
    needsReconnection: c.needs_reconnection,
  }));
  // Ranked on the resolver's own scope selection, so a candidate's `missing_scopes` is the
  // verdict's: an agent's `"*"`, written or inherited, is judged on the auth's `default_scopes`.
  // Without a manifest nothing is judged: the listing order stands.
  const ranked = manifest
    ? rankByLeastPrivilege(requirement ?? { manifest, agentTools: [], agentScopes: [] }, scoped)
    : scoped.map((row) => ({ row, scopeFit: "unjudged" as const, missingScopes: [] }));
  const candidates: IntegrationCandidate[] = ranked.map(({ row, scopeFit, missingScopes }) => ({
    ...row.c,
    missing_scopes: missingScopes,
    scope_fit: scopeFit,
    is_own:
      actor.type === "user"
        ? row.c.owner_user_id === actor.id
        : row.c.owner_end_user_id === actor.id,
  }));

  // `[]` (bound to none, or switched off here) has no member to name a source.
  const resolved = resolution.resolved[integrationId] ?? null;
  // Neither a set nor an error only when the integration manifest could not be
  // fetched (buildRequirement returned null, `includeInert` notwithstanding):
  // no verdict to report, so both fields stay null rather than guessed.
  const err = resolution.errors.find((e) => e.integrationId === integrationId) ?? null;
  const warning = args.runWarnings.find((w) => w.integrationId === integrationId) ?? null;

  return {
    source: resolved?.[0]?.source ?? err?.source ?? null,
    error_code: err?.code ?? null,
    warning: warning ? translateResolutionError(warning) : null,
    // A set that failed its health check is still the set the layer binds.
    resolved_connection_ids: resolved
      ? resolved.map((r) => r.connectionId)
      : (err?.boundConnectionIds ?? []),
    resolved_missing_scopes: err?.missingScopes ?? [],
    admin_pinned_connection_ids: adminPinnedConnectionIds,
    member_pinned_connection_ids: memberPinnedConnectionIds,
    org_default_connection_ids: orgDefault?.connection_ids ?? null,
    org_default_enforced: orgDefault?.enforce ?? false,
    additional_connections_allowed: additionsOpen(
      adminPin?.allow_additional_connections ?? false,
      orgDefault?.enforce ?? false,
    ),
    can_add_connection: canConnect && (canConfigureIntegrations || !blocked),
    candidates,
  };
}

/** Bulk per-agent connection readiness — one call covering badge, picker, and pre-run check. */
interface AgentConnectionReadiness {
  /** True iff the run would be refused — an inactive agent, or a connection the resolver rejects. */
  blocks_run: boolean;
  /**
   * What blocks the run. The integration portion of the 409 envelope (same
   * `field: integrations.<id>` shape), plus `agent_not_active` when the SPACE
   * has switched the agent off: the three execution doors answer that with a
   * 404, and this read reports it instead, because a panel that 404s cannot
   * tell anyone what to fix.
   */
  errors: ValidationFieldError[];
  /** Every declared integration with its management verdict (includeInert) + run-blocking flag. */
  integrations: Array<{
    integration_package_id: string;
    /** The agent's `integrations_configuration.<id>.required`. */
    required: boolean;
    run_blocking: boolean;
    /** Declared, with nothing a run would start: the run cascade skips it. */
    inert: boolean;
    resolution: IntegrationAgentResolution;
  }>;
}

/**
 * Bulk connection readiness for an agent. Resolves the manifest ONCE for the
 * requested version and runs each cascade once for the whole agent, so a page
 * load costs two cascades regardless of how many integrations are declared.
 *
 * `blocks_run` / `errors` come from `resolveConnectionsForRun` with the RUN
 * semantics (`includeInert: false` + the required-auth carve-out) — the exact
 * resolver call the run-kickoff 409 uses — so the UI's pre-run signal can never
 * disagree with the actual gate. The per-integration `resolution` DTOs come
 * from a second `includeInert: true` cascade over the same manifest, so every
 * declared integration, even an inert one, stays manageable in the Connexions
 * tab. Both are handed to the picks; nothing downstream re-reads the package.
 */
export async function resolveAgentConnectionReadiness(args: {
  scope: SpaceScope;
  agentPackageId: string;
  principal: ConnectionPrincipal;
  /** `integrations:connect` and `integrations:configure`: together they drive `can_add_connection`. */
  canConnect: boolean;
  canConfigureIntegrations: boolean;
  /**
   * Version selector (`draft` | `published` | concrete semver | dist-tag) —
   * REQUIRED, and the router's decision, not this service's. Who may name
   * `draft` is a question about the CALLER (`holdsPackageWriteAuthority`), which
   * a service taking a `SpaceScope` cannot answer — so any default computed
   * here would judge a definition the launch form and the run route do not
   * execute. The route decides once, with `defaultDefinitionSelector`, and
   * hands the answer over.
   */
  version: string;
}): Promise<AgentConnectionReadiness> {
  const { scope, agentPackageId, principal, canConnect, canConfigureIntegrations, version } = args;
  const actor = principal.actor;
  const loaded = await getPackage(agentPackageId, scope.orgId);
  if (!loaded) throw notFound(`Agent '${agentPackageId}' not found in this organization`);
  // The SPACE's own switch, asked here and reported rather than thrown. The run
  // doors refuse a switched-off agent with `404 agent_not_active_in_space`
  // (`requireActiveAgent`); readiness is the panel that EXPLAINS a refusal, so
  // it answers 200 and carries the cause next to `integration_not_active`. The
  // rest of the readiness still resolves: an operator about to switch the agent
  // back on wants to know what ELSE is missing, in one pass.
  const agentActive = await isPackageActiveHere(scope, agentPackageId);
  const { agent } = await resolveAgentRunVersion(loaded, version);
  const agentManifest = agent.manifest as unknown as Record<string, unknown>;
  const declared = parseManifestIntegrations(agentManifest);

  // One memo shared by BOTH cascades and every per-integration pick below.
  // Without it each pick re-fetched every integration manifest, so an agent
  // declaring N integrations paid O(N²) manifest reads for one page load.
  const manifestCache: IntegrationManifestCache = new Map();

  // Seed that memo with each declared integration's PINNED manifest BEFORE
  // either cascade reads it — the same seeding the run performs at kickoff
  // (run-pipeline Step 2a / run-creation, both via
  // `freezeRunSpawnDependencies` → `resolveRunIntegrationVersions`). Unseeded,
  // `buildRequirement` falls through to `fetchIntegrationManifest`, which reads
  // `packages.draft_manifest`: the readiness verdict would then judge auth keys
  // and required scopes against the integration author's LIVE DRAFT while the
  // run-kickoff 409 judges them against the pinned published version — exactly
  // the disagreement this function's contract above forbids. (This is the
  // integration-manifest half of that contract.)
  //
  // The result is deliberately ignored. An unsatisfiable pin is a
  // `dependency_unresolved` (422) the kickoff raises on its own, not a
  // connection verdict this endpoint can express; the ids it leaves unseeded
  // keep the pre-existing draft fallback rather than blanking the Connexions
  // tab. Every id that DID resolve is seeded either way.
  //
  // Independent of the `version` selector: that selector picks the AGENT
  // manifest, and a run of the draft agent still freezes its integration pins
  // against published versions. Seeding unconditionally is what keeps the two
  // aligned for `?version=draft` as well.
  await resolveRunIntegrationVersions({
    agentManifest,
    orgId: scope.orgId,
    manifestCache,
  });

  const userId = actor.type === "user" ? actor.id : null;

  // Two cascades, deliberately — they answer different questions over the SAME
  // resolved manifest. The run gate excludes inert integrations (and applies
  // the required-auth carve-out); the management DTO includes them so an inert
  // integration stays pinnable in the Connexions tab. Neither is derivable from
  // the other, but both are agent-level: one call each, not one per integration.
  const [runResolution, pickResolution, memberPins] = await Promise.all([
    resolveConnectionsForRun({
      agentManifest,
      packageId: agent.id,
      actor,
      scope: { orgId: scope.orgId, spaceId: scope.spaceId },
      manifestCache,
    }),
    resolveConnectionsForRun({
      agentManifest,
      packageId: agent.id,
      actor,
      scope: { orgId: scope.orgId, spaceId: scope.spaceId },
      includeInert: true,
      manifestCache,
    }),
    userId
      ? listMemberPinsForAgent(scope, agent.id, userId)
      : Promise.resolve([] as MemberPinSummary[]),
  ]);
  const blockingIds = new Set(runResolution.errors.map((e) => e.integrationId));
  // Judged with `includeInert` and by no run: an unloadable manifest is judged by neither.
  const inert = (id: string) =>
    !(id in runResolution.resolved) &&
    !blockingIds.has(id) &&
    (id in pickResolution.resolved || pickResolution.errors.some((e) => e.integrationId === id));

  const resolutions = await Promise.all(
    declared.map((e) =>
      resolveAgentIntegrationPick({
        scope,
        agentPackageId: agent.id,
        integrationId: e.id,
        principal,
        canConnect,
        canConfigureIntegrations,
        agentManifest,
        resolution: pickResolution,
        runWarnings: runResolution.warnings,
        memberPins,
        manifestCache,
      }),
    ),
  );

  const errors: ValidationFieldError[] = runResolution.errors.map(translateResolutionError);
  if (!agentActive) {
    // First in the list: every other entry describes something to configure,
    // and none of it can run while the space has the agent switched off.
    const notActive: ValidationFieldError & { code: ReadinessErrorCode } = {
      field: "agent",
      code: "agent_not_active",
      title: "Agent Not Active",
      message: `Agent '${agent.id}' is not active in this space.`,
    };
    errors.unshift(notActive);
  }

  return {
    blocks_run: errors.length > 0,
    errors,
    integrations: declared.map((e, i) => ({
      integration_package_id: e.id,
      required: e.required === true,
      run_blocking: blockingIds.has(e.id),
      inert: inert(e.id),
      resolution: resolutions[i]!,
    })),
  };
}
