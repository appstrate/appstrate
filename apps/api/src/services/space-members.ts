// SPDX-License-Identifier: Apache-2.0

/**
 * Explicit space membership (RBAC spec §6.4). Two rules shape every function:
 *
 *  - **Owners and admins are never rows** — their reach is implied by the org
 *    role, so a row would be a second source of truth the resolver ignores.
 *  - **A space member is an org member first.** `space_members.user_id` has no
 *    org column, so the org tier is enforced here, in the service.
 */

import { and, asc, eq, inArray, isNotNull, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  integrationConnections,
  organizationMembers,
  profiles,
  spaceMembers,
  spaceRoles,
  spaces,
  user as userTable,
} from "@appstrate/db/schema";
import type { SpaceRolePreset } from "@appstrate/core/permissions";
import type { SpaceMember } from "@appstrate/shared-types";
import { conflict, notFound } from "../lib/errors.ts";
import {
  customRoleOn,
  loadSpaceMember,
  MEMBERSHIP_COLUMNS,
  memberFromJoin,
  resolveSpaceRole,
  toSpaceRoleWire,
  type SpaceAccessRow,
  type SpaceRoleRef,
} from "../lib/space-role.ts";
import { assertCanGrantSpaceRole, assertCanManageSpaceMember } from "../lib/space-role-policy.ts";
import type { DbOrTx, Tx } from "../lib/db-helpers.ts";

/** Assignment as the write routes accept it: one preset, or one custom role id. */
export type SpaceRoleAssignment = { preset_role: SpaceRolePreset } | { custom_role_id: string };

/** Resolve a known email without exposing the organization's member directory. */
export async function resolveOrgMemberEmail(orgId: string, email: string): Promise<string> {
  const [member] = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .innerJoin(userTable, eq(userTable.id, organizationMembers.userId))
    .where(
      and(eq(organizationMembers.orgId, orgId), eq(userTable.email, email.trim().toLowerCase())),
    )
    .limit(1);
  if (!member) throw notFound("User is not a member of this organization");
  return member.userId;
}

/**
 * Who reaches `spaceId`, not just who was added — otherwise "who has access"
 * reads as a much shorter list than it is.
 *
 * `includeImplicit` is the disclosure boundary: an implicit row names an org
 * member this space granted nothing to, so it is the ORG DIRECTORY seen through
 * a space and is gated on `members:read` by the route. Explicit rows are the
 * space's own data and always list.
 */
export async function listSpaceMembers(
  orgId: string,
  spaceId: string,
  includeImplicit: boolean,
): Promise<SpaceMember[]> {
  // The space, the org members and their explicit rows in ONE statement (RBAC
  // spec §4.4). Without `includeImplicit` the answer is confined to explicit rows.
  const rows = await db
    .select({
      space: {
        id: spaces.id,
        visibility: spaces.visibility,
        defaultRole: spaces.defaultRole,
        ownerUserId: spaces.ownerUserId,
      },
      userId: organizationMembers.userId,
      orgRole: organizationMembers.role,
      name: userTable.name,
      email: userTable.email,
      displayName: profiles.displayName,
      createdAt: spaceMembers.createdAt,
      ...MEMBERSHIP_COLUMNS,
    })
    .from(spaces)
    .innerJoin(organizationMembers, eq(organizationMembers.orgId, spaces.orgId))
    .innerJoin(userTable, eq(userTable.id, organizationMembers.userId))
    .leftJoin(profiles, eq(profiles.id, organizationMembers.userId))
    .leftJoin(
      spaceMembers,
      and(eq(spaceMembers.spaceId, spaces.id), eq(spaceMembers.userId, organizationMembers.userId)),
    )
    .leftJoin(spaceRoles, customRoleOn)
    .where(
      and(
        eq(spaces.id, spaceId),
        eq(spaces.orgId, orgId),
        includeImplicit ? undefined : isNotNull(spaceMembers.userId),
      ),
    );

  const out: SpaceMember[] = [];
  for (const row of rows) {
    const member = memberFromJoin(row);
    // The fourth argument is the user THIS row is about, not the request's
    // caller: the question asked of the resolver is "what would this person
    // hold here". On a personal space that answers `admin` for its owner and
    // `null` for everyone else, so the list is the owner alone (decision 10).
    const effective = resolveSpaceRole(row.orgRole, row.space, member, row.userId);
    if (!effective) continue;
    out.push({
      object: "space_member",
      userId: row.userId,
      name: row.displayName ?? row.name ?? null,
      email: row.email ?? null,
      org_role: row.orgRole,
      source: member ? "explicit" : row.orgRole === "member" ? "open_space" : "org_role",
      role: toSpaceRoleWire(effective),
      createdAt: row.createdAt?.toISOString() ?? null,
    });
  }
  return out;
}

/**
 * Lock an org member's row until the caller's transaction commits — the lock
 * every org-role change, org removal and space grant takes, so the role read
 * here cannot move under the caller. `undefined` when they are not a member.
 */
export async function lockOrgMember(tx: DbOrTx, orgId: string, userId: string) {
  const [member] = await tx
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    .for("update");
  return member;
}

/**
 * Add an explicit member, or update an existing row when requested. Creating
 * never replaces a row: invite authority cannot bypass change-role authority.
 * A role change keeps the original `addedBy` attribution.
 *
 * @throws 404 when the target is not an org member, or the custom role is not
 *   this org's; 409 when the target is an owner/admin or already explicit on
 *   create; 403 when the role exceeds the actor's permissions.
 */
export async function saveSpaceMember(params: {
  orgId: string;
  spaceId: string;
  userId: string;
  assignment: SpaceRoleAssignment;
  actorPermissions: ReadonlySet<string> | undefined;
  addedBy: string;
  requireExisting?: boolean;
}): Promise<void> {
  const { orgId, spaceId, userId, assignment, addedBy } = params;
  // Serialize with org promotion/removal, which lock this row before cleaning
  // up space memberships. A transaction alone would still allow stale grants.
  return db.transaction(async (tx) => {
    await assertSpaceTakesMembers(tx, spaceId);
    const target = await lockOrgMember(tx, orgId, userId);
    const targetRole = target?.role;
    if (!targetRole) throw notFound("User is not a member of this organization");
    if (targetRole === "owner" || targetRole === "admin") {
      throw conflict(
        "redundant_space_role",
        `${targetRole}s already run every space in the organization; an explicit role would grant nothing`,
      );
    }
    const memberFilter = and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId));
    // Read in the SAME transaction as the write: a role change is authority
    // over the standing the target holds NOW, not only over the one handed out.
    const existing = await loadSpaceMember(spaceId, userId, tx);
    if (params.requireExisting) {
      if (!existing) throw notFound("Space member not found");
      assertCanManageSpaceMember(params.actorPermissions, existing.ref);
    } else if (existing) {
      throw existingSpaceMember();
    }
    const values = await assignmentColumns(orgId, assignment, params.actorPermissions, tx);

    if (params.requireExisting) {
      const updated = await tx
        .update(spaceMembers)
        .set(values)
        .where(memberFilter)
        .returning({ userId: spaceMembers.userId });
      if (updated.length === 0) throw notFound("Space member not found");
      return;
    }

    const inserted = await tx
      .insert(spaceMembers)
      .values({ spaceId, userId, addedBy, ...values })
      .onConflictDoNothing({ target: [spaceMembers.spaceId, spaceMembers.userId] })
      .returning({ userId: spaceMembers.userId });
    if (inserted.length === 0) throw existingSpaceMember();
  });
}

/**
 * A personal space has exactly one member — its owner — and no row for them
 * (RBAC spec §3.6, decision 10). "Personal" has to mean one thing: collaboration
 * goes through a team space, distribution through sharing. Converting the space
 * (`POST /api/spaces/{id}/convert-to-team`) is what makes it grantable.
 */
async function assertSpaceTakesMembers(tx: DbOrTx, spaceId: string): Promise<void> {
  const [space] = await tx
    .select({ ownerUserId: spaces.ownerUserId })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  if (space?.ownerUserId) {
    throw conflict(
      "personal_space_has_no_members",
      "A personal space belongs to one member and takes no others. " +
        "Convert it to a team space first.",
    );
  }
}

function existingSpaceMember() {
  return conflict(
    "space_member_exists",
    "This user already has an explicit space role; use PATCH to change it",
  );
}

/** Columns the two nullable role references occupy — exactly one is set. */
interface RoleColumns {
  presetRole: SpaceRolePreset | null;
  customRoleId: string | null;
}

/** What a removal did, and the standing the target is left with. */
export interface SpaceMemberRemoval {
  /** False when there was no explicit row — the caller renders that as 404. */
  removed: boolean;
  /**
   * The standing the target holds with NO explicit row, resolved under the
   * removal's lock. It is what the deleted row was hiding — and, when
   * `removed` is false, what they already held. `null` means they reach the
   * space no longer.
   */
  accessAfter: SpaceRoleRef | null;
  /** The connections the removal unshared, for the caller's audit. */
  unsharedConnectionIds: string[];
}

/**
 * Remove an explicit row, and report the implicit standing it leaves behind.
 *
 * Both bounds live here, not at the route: the rows they rest on and the DELETE
 * that acts on them must be one statement's worth of truth.
 *
 *  - the **grant** bound, on `accessAfter`: dropping an explicit restriction can
 *    hand out the open space's default role, so the caller must have been able
 *    to grant it. At the route this rested on an org role a concurrent
 *    promotion could move before the DELETE ran (#1439).
 *  - the **manage** bound, on the row being dropped: without it,
 *    `space-members:remove` alone ejects a space admin, because a removal in a
 *    `closed` or `private` space exposes no implicit role for the grant bound
 *    to refuse.
 *
 * Grant first, so a caller who may not touch this target learns nothing about
 * whether the row exists.
 *
 * What the lock covers, precisely: `lockOrgMember` is the lock org promotion,
 * demotion and removal take before touching space memberships, so the ORG ROLE
 * and the MEMBER ROW cannot move under the delete. The SPACE row is the request
 * pipeline's (`c.get("space")`), pinned for the request like everywhere else —
 * `applySpacePermissions` resolved the caller's own ceiling from that same row,
 * so re-reading it here would judge the bound against a space the permission
 * that admitted the request was never checked against. The row is share-locked
 * ({@link lockSpaceRow}), so a concurrent `PATCH /api/spaces/{id}` cannot commit
 * while this removal runs; one that committed before the lock is not re-read —
 * the request-scoped window RBAC spec §4.4 states and §13.8 declines to close.
 *
 * @throws 403 when the caller could not have granted the standing left behind,
 *   or the one being dropped.
 */
export async function removeSpaceMember(params: {
  orgId: string;
  space: SpaceAccessRow;
  userId: string;
  actorPermissions: ReadonlySet<string> | undefined;
}): Promise<SpaceMemberRemoval> {
  const { orgId, space, userId } = params;
  return db.transaction(async (tx) => {
    const target = await lockOrgMember(tx, orgId, userId);
    await lockSpaceRow(tx, space.id);
    // The standing is the TARGET's, so the caller id is theirs — a personal
    // space resolves `admin` for its owner and nothing for anyone else. No
    // member row: the removal is about to delete the only one there could be.
    const accessAfter = target ? resolveSpaceRole(target.role, space, null, userId) : null;
    assertCanGrantSpaceRole(params.actorPermissions, accessAfter);
    const existing = await loadSpaceMember(space.id, userId, tx);
    if (!existing) return { removed: false, accessAfter, unsharedConnectionIds: [] };
    assertCanManageSpaceMember(params.actorPermissions, existing.ref);
    const deleted = await tx
      .delete(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, space.id), eq(spaceMembers.userId, userId)))
      .returning({ userId: spaceMembers.userId });
    if (deleted.length === 0) return { removed: false, accessAfter, unsharedConnectionIds: [] };
    const unsharedConnectionIds = await unshareConnectionsOfOwnersWithoutAccess(tx, {
      orgId,
      userId,
      spaceId: space.id,
    });
    return { removed: true, accessAfter, unsharedConnectionIds };
  });
}

/** A grant that was dropped, as the audit trail records it. */
export interface RevokedSpaceAssignment {
  spaceId: string;
  presetRole: SpaceRolePreset | null;
  customRoleId: string | null;
}

/**
 * Called on promotion to admin/owner, in the same transaction as the role
 * change: the rows become dead weight, and a later demotion must not silently
 * restore a role nobody re-granted. The deleted rows are returned because they
 * are the only trace left of what the promotion revoked.
 */
export async function deleteSpaceMembershipsInOrg(
  tx: Pick<typeof db, "select" | "delete">,
  orgId: string,
  userId: string,
): Promise<RevokedSpaceAssignment[]> {
  // Every space of the org, personal ones included, and that is not a leak:
  // a personal space holds no `space_members` row at all
  // ({@link assertSpaceTakesMembers}), so a promotion has nothing to revoke
  // there and cannot reach inside one.
  const orgSpaces = await tx.select({ id: spaces.id }).from(spaces).where(eq(spaces.orgId, orgId));
  if (orgSpaces.length === 0) return [];
  return tx
    .delete(spaceMembers)
    .where(
      and(
        eq(spaceMembers.userId, userId),
        inArray(
          spaceMembers.spaceId,
          orgSpaces.map((s) => s.id),
        ),
      ),
    )
    .returning({
      spaceId: spaceMembers.spaceId,
      presetRole: spaceMembers.presetRole,
      customRoleId: spaceMembers.customRoleId,
    });
}

/**
 * Unshare, and return, every user-owned shared connection in `scope` whose owner no longer
 * reaches its space — in the SAME transaction as the access loss. No `assertConnectionsUnpinned`:
 * a pin or default naming one fails loudly at resolution (`pinned_connection_unavailable`).
 * Every access-loss path unshares here, locking the rows in id order, so two of them sharing
 * rows (an org exit and a space close) wait on each other instead of deadlocking.
 */
export async function unshareConnectionsOfOwnersWithoutAccess(
  tx: Tx,
  scope: { orgId: string; userId?: string; spaceId?: string },
): Promise<string[]> {
  const lost = await connectionsOfOwnersWithoutAccess(
    tx,
    and(
      eq(spaces.orgId, scope.orgId),
      eq(integrationConnections.sharedWithOrg, true),
      scope.userId === undefined ? undefined : eq(integrationConnections.userId, scope.userId),
      scope.spaceId === undefined ? undefined : eq(spaces.id, scope.spaceId),
    ),
  );
  if (lost.length === 0) return [];
  const locked = await tx
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(
      and(inArray(integrationConnections.id, lost), eq(integrationConnections.sharedWithOrg, true)),
    )
    .orderBy(asc(integrationConnections.id))
    .for("update");
  const ids = locked.map((row) => row.id);
  if (ids.length === 0) return [];
  await tx
    .update(integrationConnections)
    .set({ sharedWithOrg: false, updatedAt: new Date() })
    .where(inArray(integrationConnections.id, ids));
  return ids;
}

/**
 * 409 `connection_owner_without_access` when sharing a connection whose owner no longer reaches its
 * space — the share-side twin of {@link unshareConnectionsOfOwnersWithoutAccess}. Call it in the
 * sharing transaction, before the write. No-op for an end user's connection.
 */
export async function assertOwnerReachesSpaceForShare(tx: Tx, connectionId: string): Promise<void> {
  const [conn] = await tx
    .select({
      userId: integrationConnections.userId,
      spaceId: integrationConnections.spaceId,
      orgId: spaces.orgId,
    })
    .from(integrationConnections)
    .innerJoin(spaces, eq(spaces.id, integrationConnections.spaceId))
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);
  if (!conn?.userId) return;
  await lockOrgMember(tx, conn.orgId, conn.userId);
  await lockSpaceRow(tx, conn.spaceId);
  const lost = await connectionsOfOwnersWithoutAccess(
    tx,
    eq(integrationConnections.id, connectionId),
  );
  if (lost.length > 0) {
    throw conflict(
      "connection_owner_without_access",
      "The connection's owner no longer has access to this space, so it cannot be shared.",
    );
  }
}

/**
 * Share-lock, in id order, every space of `orgId` where `userId` shares a connection — the org
 * role change's side of {@link lockSpaceRow}; the caller's member lock keeps that set fixed.
 */
export async function lockSpacesOfSharedConnections(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<void> {
  const owned = tx
    .select({ spaceId: integrationConnections.spaceId })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.userId, userId),
        eq(integrationConnections.sharedWithOrg, true),
      ),
    );
  await tx
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.orgId, orgId), inArray(spaces.id, owned)))
    .orderBy(asc(spaces.id))
    .for("share");
}

/**
 * Share-lock a space row (conflicts with the UPDATE closing it). A share, a member removal, an org
 * role change and a close each lock the owner's `org_members` row and/or this row, so whichever
 * commits second sees the others: no connection stays shared by an owner without access.
 */
async function lockSpaceRow(tx: Tx, spaceId: string): Promise<void> {
  await tx.select({ id: spaces.id }).from(spaces).where(eq(spaces.id, spaceId)).for("share");
}

/** User-owned connections matching `filter` whose owner no longer reaches their space. */
async function connectionsOfOwnersWithoutAccess(
  tx: Tx,
  filter: SQL | undefined,
): Promise<string[]> {
  const rows = await tx
    .select({
      id: integrationConnections.id,
      userId: integrationConnections.userId,
      orgRole: organizationMembers.role,
      space: {
        id: spaces.id,
        visibility: spaces.visibility,
        defaultRole: spaces.defaultRole,
        ownerUserId: spaces.ownerUserId,
      },
      ...MEMBERSHIP_COLUMNS,
    })
    .from(integrationConnections)
    .innerJoin(spaces, eq(spaces.id, integrationConnections.spaceId))
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, spaces.orgId),
        eq(organizationMembers.userId, integrationConnections.userId),
      ),
    )
    .leftJoin(
      spaceMembers,
      and(
        eq(spaceMembers.spaceId, spaces.id),
        eq(spaceMembers.userId, integrationConnections.userId),
      ),
    )
    .leftJoin(spaceRoles, customRoleOn)
    .where(and(isNotNull(integrationConnections.userId), filter));

  return rows
    .filter(
      (row) =>
        row.orgRole === null ||
        resolveSpaceRole(row.orgRole, row.space, memberFromJoin(row), row.userId) === null,
    )
    .map((row) => row.id);
}

/**
 * The FK alone would accept another org's bundle, so the org is checked here —
 * a bundle from a neighbouring organization reads as "not found", never as a
 * grantable role.
 *
 * Both branches end on the same question, `assertCanGrantSpaceRole`: a caller
 * may only hand out permissions they hold in this space. That bound is what
 * keeps a bundle from being a privilege ladder, and it applies to a preset and
 * a custom role identically.
 */
async function assignmentColumns(
  orgId: string,
  assignment: SpaceRoleAssignment,
  actorPermissions: ReadonlySet<string> | undefined,
  tx: DbOrTx,
): Promise<RoleColumns> {
  if ("preset_role" in assignment) {
    assertCanGrantSpaceRole(actorPermissions, { kind: "preset", preset: assignment.preset_role });
    return { presetRole: assignment.preset_role, customRoleId: null };
  }
  const [role] = await tx
    .select({
      id: spaceRoles.id,
      key: spaceRoles.key,
      name: spaceRoles.name,
      permissions: spaceRoles.permissions,
    })
    .from(spaceRoles)
    .where(and(eq(spaceRoles.id, assignment.custom_role_id), eq(spaceRoles.orgId, orgId)))
    .limit(1);
  if (!role) throw notFound("Space role not found");
  assertCanGrantSpaceRole(actorPermissions, { kind: "custom", role });
  return { presetRole: null, customRoleId: role.id };
}
