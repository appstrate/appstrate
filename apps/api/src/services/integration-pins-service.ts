// SPDX-License-Identifier: Apache-2.0

/**
 * Service layer for `integration_pins` + the per-(space, integration)
 * `block_user_connections` toggle + connection edits (label, share targets).
 * Consumed by the routes in `routes/integrations.ts` and `routes/me.ts`.
 *
 * Pin model (flat): one row per (space, agent, integration, scope), carrying
 * the bound set in `connection_ids` — `[]` pins to no connection, no row is no pin.
 * Scope = admin (`user_id IS NULL`) OR member (`user_id = caller.id`).
 *
 * All governance operations — the route layer enforces
 * `requirePermission("integrations", "configure")`; this layer assumes the
 * caller already holds it.
 */

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { AuditPayload } from "@appstrate/core/module";
import { db, toRows } from "@appstrate/db/client";
import {
  spacePackages,
  packageShares,
  integrationConnections,
  integrationPins,
  packages,
} from "@appstrate/db/schema";
import type {
  IntegrationConnectionRow as ConnectionRow,
  IntegrationPinRow as PinRow,
} from "@appstrate/db/schema";
import type {
  AccessibleIntegrationConnection,
  ConsumingAgentSummary,
  IntegrationAgentResolution,
  IntegrationCandidate,
  IntegrationPin,
} from "@appstrate/shared-types";
import { missingScopesForConnection } from "@appstrate/core/integration";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { activatePackageWithin, isPackageActiveHere, placedRowFilter } from "./space-packages.ts";
import { activeHereSql } from "./package-activation.ts";
import {
  getPackageDisplayName,
  notEphemeralFilter,
  orgOrSystemFilter,
} from "../lib/package-helpers.ts";
import { ApiError, conflict, forbidden, notFound } from "../lib/errors.ts";
import { isUniqueViolation } from "../lib/db-helpers.ts";
import type { SpaceScope } from "../lib/scope.ts";
import type { Permission } from "../lib/permissions.ts";
import { actorFilter, actorFromIds, actorOwns, type Actor } from "../lib/actor.ts";
import type { ValidationFieldError } from "../lib/errors.ts";
import { getPackage } from "./package-catalog.ts";
import { resolveAgentRunVersion } from "./agent-version-resolver.ts";
import { fetchIntegrationManifest, resolveRunIntegrationVersions } from "./integration-service.ts";
import { getOrgDefault } from "./integration-org-defaults-service.ts";
import { resolveConnectionOwnerNames } from "./integration-connection-owner-names.ts";
import {
  assertConnectionsUnpinned,
  connectionReachView,
  lockLabelKeys,
} from "./integration-connections.ts";
import {
  connectionInSpace,
  ownRowInSpace,
  scopedOrSharedIn,
  sharedInSpace,
  usableInSpace,
} from "./connection-reach.ts";
import { assertConnectionShareable, invalidShareTarget } from "./space-members.ts";
import { disableForeignSchedules } from "./schedules-naming-connection.ts";
import {
  resolveConnectionsForRun,
  translateResolutionError,
  isUserConnectionCreationBlocked,
  requirementOf,
  servingCandidates,
} from "./integration-connection-resolver.ts";
import type {
  ConnectionResolutionResult,
  ConnectionResolutionWarning,
} from "@appstrate/core/integration";
import type { IntegrationManifestCache } from "./integration-service.ts";
import { placementRowJoin, placementShareJoin } from "./package-placement.ts";

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

function toPinSummary(pin: PinRow): PinSummary {
  return {
    agent_package_id: pin.packageId,
    integration_package_id: pin.integrationId,
    connection_ids: pin.connectionIds,
    createdAt: pin.createdAt.toISOString(),
    updatedAt: pin.updatedAt.toISOString(),
  };
}

/**
 * List every admin pin governing a (space, integration). Used by the admin UI
 * to render the per-agent pin section + by the runtime resolver via the
 * dedicated `loadPins` helper (private to the resolver, see
 * integration-connection-resolver.ts).
 */
export async function listIntegrationPins(
  scope: SpaceScope,
  integrationId: string,
): Promise<PinSummary[]> {
  const rows = await db
    .select()
    .from(integrationPins)
    .where(
      and(
        eq(integrationPins.spaceId, scope.spaceId),
        eq(integrationPins.integrationId, integrationId),
        isNull(integrationPins.userId),
      ),
    )
    .orderBy(integrationPins.packageId);
  return rows.map(toPinSummary);
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
  createdBy: string | null;
}

/**
 * Replace the admin pin set. Validates that EVERY pinned connection:
 *   1. serves this space,
 *   2. references the integration this pin governs,
 *   3. is shared into this space (pinning a personal connection would
 *      leak the admin's identity to other members at run time).
 * An empty set pins to none; the resolver refuses it where the running version requires the integration.
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
    validateOpts: {},
    createdBy: input.createdBy,
  });
}

/** A pin write: the set it replaced (`null` when there was none) and the stored pin. */
interface PinWrite {
  previous: string[] | null;
  pin: PinSummary;
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
 * Raw SQL: `onConflictDoUpdate` cannot target the index's `coalesce`; the
 * returned row goes through drizzle's column mappers (drivers differ).
 */
async function upsertPin(args: {
  scope: SpaceScope;
  agentPackageId: string;
  integrationId: string;
  connectionIds: string[];
  userIdValue: string | null;
  validateOpts: { allowOwnedBy?: string };
  createdBy: string | null;
}): Promise<PinWrite> {
  const { scope, agentPackageId, integrationId, connectionIds, userIdValue, createdBy } = args;
  await assertAgentActiveHere(scope, agentPackageId);

  const ids = sql`ARRAY[${sql.join(
    connectionIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
  await validatePinTargets(scope, integrationId, connectionIds, args.validateOpts);
  const [previous] = await db
    .select({ connectionIds: integrationPins.connectionIds })
    .from(integrationPins)
    .where(pinKey(scope, agentPackageId, integrationId, userIdValue))
    .limit(1);
  const [row] = toRows<{
    connection_ids: string | unknown[];
    created_at: string | Date;
    updated_at: string | Date;
  }>(
    await db.execute(sql`
    INSERT INTO ${integrationPins}
      (space_id, package_id, integration_package_id, user_id, connection_ids, created_by)
    VALUES (${scope.spaceId}, ${agentPackageId}, ${integrationId}, ${userIdValue}, ${ids}, ${createdBy})
    ON CONFLICT (space_id, package_id, integration_package_id, (coalesce(user_id, '')))
    DO UPDATE SET
      connection_ids = EXCLUDED.connection_ids,
      created_by = EXCLUDED.created_by,
      updated_at = now()
    RETURNING connection_ids, created_at, updated_at
  `),
  );
  return {
    previous: previous?.connectionIds ?? null,
    pin: {
      agent_package_id: agentPackageId,
      integration_package_id: integrationId,
      connection_ids: integrationPins.connectionIds.mapFromDriverValue(
        row!.connection_ids,
      ) as string[],
      createdAt: (
        integrationPins.createdAt.mapFromDriverValue(row!.created_at) as Date
      ).toISOString(),
      updatedAt: (
        integrationPins.updatedAt.mapFromDriverValue(row!.updated_at) as Date
      ).toISOString(),
    },
  };
}

/**
 * Delete one pin row — the admin pin for `userId: null`, else that member's; `previous` is the
 * set it held, `null` when there was none.
 */
export async function deletePin(
  scope: SpaceScope,
  agentPackageId: string,
  integrationId: string,
  userId: string | null,
): Promise<{ previous: string[] | null }> {
  const [row] = await db
    .delete(integrationPins)
    .where(pinKey(scope, agentPackageId, integrationId, userId))
    .returning({ connectionIds: integrationPins.connectionIds });
  return { previous: row?.connectionIds ?? null };
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
 * Member writes their own preference for this (agent, integration) —
 * the persisted row the resolver sees on every run (layer 4 of the
 * cascade).
 */
export async function upsertMemberPin(
  scope: SpaceScope,
  input: UpsertMemberPinInput,
): Promise<PinWrite> {
  return upsertPin({
    scope,
    agentPackageId: input.agentPackageId,
    integrationId: input.integrationId,
    connectionIds: input.connectionIds,
    userIdValue: input.userId,
    validateOpts: { allowOwnedBy: input.userId },
    createdBy: input.userId,
  });
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

// ─────────────────────────── Connection edits ─────────────────────────────────

export interface ConnectionViewer {
  actor: Actor;
  /** The space the edit is made from; `null` on the account surface, where only the owner edits. */
  spaceId: string | null;
  /** Holds `integrations:configure` in `spaceId`. */
  governs: boolean;
  /** The space a delegated credential is bound to, confining its edits to that space; `null`: none. */
  boundSpaceId: string | null;
  /** The viewer's permissions in `spaceId` — asked of each share target. */
  permissionsIn: (spaceId: string) => Promise<ReadonlySet<Permission>>;
}

interface UpdateConnectionInput {
  connectionId: string;
  viewer: ConnectionViewer;
  label?: string;
  /** The owner's full target set; a governor may only send `[]`, withdrawing the viewer's space. */
  sharedSpaceIds?: string[];
}

export interface ConnectionUpdate {
  connection: ConnectionRow;
  isOwner: boolean;
  added: string[];
  removed: string[];
  /** Other actors' schedules of a removed target naming the row; the caller removes their jobs. */
  disabledScheduleIds: string[];
}

/**
 * The one edit of a connection's label and share targets, behind both PATCH routes; the rules are
 * `connectionUpdateDescription` (OpenAPI). Lock order: the label keys, the owner's membership and
 * the target spaces, the connection row, then schedules.
 */
export async function updateConnection(input: UpdateConnectionInput): Promise<ConnectionUpdate> {
  const { connectionId, viewer, label } = input;
  const c = integrationConnections;
  const here = viewer.spaceId;
  // Seen from a space: the owner's row reaching it, or any row a governor there may withdraw.
  const visible = and(
    eq(c.id, connectionId),
    here === null
      ? undefined
      : or(
          ownRowInSpace(here, viewer.actor),
          and(sql`(${actorFilter(viewer.actor, c)}) IS NOT TRUE`, scopedOrSharedIn(here)),
        ),
  );
  const [read] = await db.select().from(c).where(visible).limit(1);
  if (!read) throw notFound(`Connection '${connectionId}' not found`);
  authorizeConnectionEdit(input, read);
  const isOwner = actorOwns(viewer.actor, read);
  const targets = input.sharedSpaceIds && [...new Set(input.sharedSpaceIds)];
  // Roles resolve outside the transaction; only a target this edit ADDS is refused (under the lock).
  const refusals = new Map<string, ApiError>();
  for (const spaceId of isOwner && targets ? targets : []) {
    const permissions = await viewer.permissionsIn(spaceId);
    if (!permissions.has("integrations:connect")) {
      refusals.set(
        spaceId,
        forbidden(`Sharing into space '${spaceId}' requires integrations:connect there`),
      );
    } else if (
      !permissions.has("integrations:configure") &&
      (await isUserConnectionCreationBlocked(spaceId, read.integrationId))
    ) {
      refusals.set(
        spaceId,
        new ApiError({
          status: 403,
          code: "connection_blocked_by_admin",
          title: "Connection Blocked by Admin",
          detail: `Personal connections to '${read.integrationId}' are disabled in space '${spaceId}': only a principal with integrations:configure there may share one into it.`,
        }),
      );
    }
  }

  return db
    .transaction(async (tx) => {
      if (label !== undefined) {
        // A row only widens (space → org): both keys it may hold.
        const key = {
          orgId: read.orgId,
          integrationId: read.integrationId,
          ownerId: (read.userId ?? read.endUserId)!,
        };
        await lockLabelKeys(tx, [
          { ...key, spaceId: read.spaceId },
          { ...key, spaceId: null },
        ]);
      }
      if (isOwner && targets && targets.length > 0) {
        await assertConnectionShareable(tx, connectionId, targets);
      }
      const [row] = await tx.select().from(c).where(visible).for("update");
      if (!row) throw notFound(`Connection '${connectionId}' not found`);
      authorizeConnectionEdit(input, row);
      const current = row.sharedSpaceIds;
      // A credential bound to a space reads that space only, so its set edits that space alone.
      const bound = viewer.boundSpaceId;
      if (bound !== null && targets?.some((id) => id !== bound)) {
        throw forbidden(
          `A credential bound to space '${bound}' can only share into it or withdraw it`,
        );
      }
      const next =
        targets === undefined
          ? current
          : !isOwner
            ? current.filter((id) => id !== here)
            : bound !== null
              ? [...current.filter((id) => id !== bound), ...targets]
              : targets;
      const added = next.filter((id) => !current.includes(id));
      const removed = current.filter((id) => !next.includes(id));
      const refused = added.find((id) => refusals.has(id));
      if (refused) throw refusals.get(refused)!;
      for (const spaceId of added) {
        const [serves] = await tx
          .select({ id: c.id })
          .from(c)
          .where(and(eq(c.id, connectionId), connectionInSpace(spaceId)));
        if (!serves) {
          throw invalidShareTarget(
            `This connection cannot serve space '${spaceId}': it is confined to its own space, or that space's default OAuth client for this integration is its own`,
          );
        }
      }
      for (const spaceId of removed) {
        await assertConnectionsUnpinned(
          tx,
          [connectionId],
          `Connection cannot be unshared from space '${spaceId}'`,
          spaceId,
        );
      }
      const [connection] = await tx
        .update(c)
        .set({
          ...(label !== undefined ? { label } : {}),
          ...(targets !== undefined ? { sharedSpaceIds: next } : {}),
          updatedAt: new Date(),
        })
        .where(eq(c.id, connectionId))
        .returning();
      const owner = actorFromIds(connection!.userId, connection!.endUserId)!;
      const disabledScheduleIds = await disableForeignSchedules(
        tx,
        removed.map((spaceId) => ({ id: connectionId, owner, inSpaceId: spaceId })),
        "connection_unshared",
      );
      return { connection: connection!, isOwner, added, removed, disabledScheduleIds };
    })
    .catch((err: unknown) => {
      if (label === undefined || !isUniqueViolation(err)) throw err;
      throw conflict(
        "connection_label_taken",
        `The owner already has a connection of this integration named '${label}'`,
      );
    });
}

/** The viewer's right to this edit of `row` — 404 when it is not theirs to see, else 403. */
function authorizeConnectionEdit(input: UpdateConnectionInput, row: ConnectionRow): void {
  const { viewer, label, sharedSpaceIds } = input;
  const here = viewer.spaceId;
  if (!actorOwns(viewer.actor, row)) {
    if (here === null) throw notFound(`Connection '${row.id}' not found`);
    if (!viewer.governs) {
      throw forbidden(
        "Only the connection owner or a principal with integrations:configure can update this connection",
      );
    }
    if (label !== undefined && row.spaceId !== here) {
      throw forbidden("Only its owner can rename a connection serving the whole organization");
    }
    if (sharedSpaceIds !== undefined && sharedSpaceIds.length > 0) {
      throw forbidden("Only the connection owner can share it; you may only withdraw this space");
    }
  }
  if (label !== undefined && viewer.boundSpaceId !== null && row.spaceId !== viewer.boundSpaceId) {
    throw forbidden(
      `A credential bound to space '${viewer.boundSpaceId}' can only rename a connection scoped to it`,
    );
  }
}

// ─────────────────────────── Shared accessor for the picker UI ────────────────

/**
 * List the connections an actor can pick from for a given
 * (space, integration). Used by the UI picker:
 * own + shared, with caller-facing labels.
 *
 * Same set — and the same predicate (`usableInSpace`) — as `listIntegrationConnections`
 * on the settings surface; only the projected DTO differs (this one carries
 * `owner_name` and the split owner ids the picker keys on, the other the
 * full connection summary).
 */
export async function listAccessibleConnections(
  scope: SpaceScope,
  integrationId: string,
  actor: Actor,
  /** A user principal sees its own rows' whole reach; a delegated credential the current space. */
  wholeReach = true,
): Promise<AccessibleIntegrationConnection[]> {
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.integrationId, integrationId),
        usableInSpace(scope.spaceId, actor),
      ),
    );
  const ownerName = await resolveConnectionOwnerNames(rows);
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
      ...connectionReachView(row, wholeReach && actorOwns(actor, row) ? null : scope.spaceId),
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
 * load-bearing rather than stylistic. This function used to load the package
 * itself and read `agent.manifest` — always the DRAFT — while its only caller
 * had already resolved the manifest for the requested `version`. On
 * `?version=<pinned>` the response therefore described the pinned version in
 * `blocks_run` and the draft in every `integrations[].resolution`, defeating
 * the reason #770 introduced the selector. Taking both as parameters makes
 * that divergence unrepresentable: there is no manifest in scope here to read
 * the wrong one from. It also removes an N+1 — the cascade ran once per
 * declared integration, each time re-fetching the package and every manifest.
 */
async function resolveAgentIntegrationPick(args: {
  scope: SpaceScope;
  agentPackageId: string;
  integrationId: string;
  actor: Actor;
  canConnect: boolean;
  canConfigureIntegrations: boolean;
  wholeReach: boolean;
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
    actor,
    canConnect,
    canConfigureIntegrations,
    agentManifest,
    resolution,
  } = args;

  const agentEntry = parseManifestIntegrations(agentManifest).find((e) => e.id === integrationId);
  // AFPS §4.4 — preserve the wildcard literal `"*"` so `missingScopesForConnection`
  // can route through the default-scopes branch of `requiredScopesForAgent`.
  // Coercing `"*"` to `[]` here would silently bypass the scope diff and let
  // a connection with zero default scopes appear "fully connected".
  const agentTools: readonly string[] | "*" = agentEntry?.tools ?? [];
  const agentScopes = agentEntry?.scopes ?? [];

  const manifestRes = await fetchIntegrationManifest(integrationId, args.manifestCache);
  const manifest = manifestRes.ok ? manifestRes.manifest : null;

  const memberPins = args.memberPins;

  const [candidatesRaw, adminPins, blocked, orgDefault] = await Promise.all([
    listAccessibleConnections(scope, integrationId, actor, args.wholeReach),
    listIntegrationPins(scope, integrationId),
    isUserConnectionCreationBlocked(scope.spaceId, integrationId),
    getOrgDefault(scope, integrationId),
  ]);

  // `null` = no pin; `[]` = a pin to no connection.
  const adminPinnedConnectionIds =
    adminPins.find((p) => p.agent_package_id === agentPackageId)?.connection_ids ?? null;
  const memberPinnedConnectionIds =
    memberPins.find((p) => p.integration_package_id === integrationId)?.connection_ids ?? null;

  // The resolver's own candidate universe (orphaned-auth guard, the dep's pinned
  // `auth_key`, auths serving the selection), so the picker offers exactly the
  // `must_choose_connection` candidates. No manifest → no verdict to align with.
  const candidateRows =
    manifest && agentEntry
      ? servingCandidates(requirementOf(agentEntry, manifest), candidatesRaw, (c) => c.auth_key)
      : candidatesRaw;
  const candidates: IntegrationCandidate[] = candidateRows.map((c) => ({
    ...c,
    missing_scopes: manifest
      ? missingScopesForConnection({
          manifest,
          authKey: c.auth_key,
          granted: c.scopes_granted,
          agentTools,
          agentScopes,
        })
      : [],
    is_own: actor.type === "user" ? c.owner_user_id === actor.id : c.owner_end_user_id === actor.id,
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
  actor: Actor;
  /** `integrations:connect` and `integrations:configure`: together they drive `can_add_connection`. */
  canConnect: boolean;
  canConfigureIntegrations: boolean;
  wholeReach: boolean;
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
  const { scope, agentPackageId, actor, canConnect, canConfigureIntegrations, version } = args;
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
  // the disagreement this function's contract above forbids. (#1178 closed the
  // agent-manifest half of it; this is the integration-manifest half.)
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

  const resolutions = await Promise.all(
    declared.map((e) =>
      resolveAgentIntegrationPick({
        scope,
        agentPackageId: agent.id,
        integrationId: e.id,
        actor,
        canConnect,
        canConfigureIntegrations,
        wholeReach: args.wholeReach,
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
    errors.unshift({
      field: "agent",
      code: "agent_not_active",
      title: "Agent Not Active",
      message: `Agent '${agent.id}' is not active in this space.`,
    });
  }

  return {
    blocks_run: errors.length > 0,
    errors,
    integrations: declared.map((e, i) => ({
      integration_package_id: e.id,
      required: e.required === true,
      run_blocking: blockingIds.has(e.id),
      resolution: resolutions[i]!,
    })),
  };
}
