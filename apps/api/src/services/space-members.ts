// SPDX-License-Identifier: Apache-2.0

/**
 * Explicit space membership (RBAC spec §6.4). Two rules shape every function:
 *
 *  - **Owners and admins are never rows** — their reach is implied by the org
 *    role, so a row would be a second source of truth the resolver ignores.
 *  - **A space member is an org member first.** `space_members.user_id` has no
 *    org column, so the org tier is enforced here, in the service.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
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
import { loadSpaceMember, resolveSpaceRole, toRef, toSpaceRoleWire } from "../lib/space-role.ts";
import { assertCanGrantSpaceRole, assertCanManageSpaceMember } from "../lib/space-role-policy.ts";
import { assertCustomRolesFeature } from "./space-roles.ts";

/** Accepts either the base client or an open transaction handle. */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

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
  space: { id: string; visibility: string; defaultRole: SpaceRolePreset },
  includeImplicit: boolean,
): Promise<SpaceMember[]> {
  const explicitRows = await db
    .select({
      userId: spaceMembers.userId,
      presetRole: spaceMembers.presetRole,
      customRoleId: spaceMembers.customRoleId,
      customKey: spaceRoles.key,
      customName: spaceRoles.name,
      customPermissions: spaceRoles.permissions,
      createdAt: spaceMembers.createdAt,
    })
    .from(spaceMembers)
    .leftJoin(spaceRoles, eq(spaceRoles.id, spaceMembers.customRoleId))
    .where(eq(spaceMembers.spaceId, space.id));

  // Without `includeImplicit` the answer is confined to the explicit rows, so
  // the directory read is narrowed to those users instead of being fetched
  // whole and discarded row by row.
  const explicitIds = explicitRows.map((row) => row.userId);
  const orgRows =
    !includeImplicit && explicitIds.length === 0
      ? []
      : await db
          .select({
            userId: organizationMembers.userId,
            role: organizationMembers.role,
            name: userTable.name,
            email: userTable.email,
            displayName: profiles.displayName,
          })
          .from(organizationMembers)
          .innerJoin(userTable, eq(userTable.id, organizationMembers.userId))
          .leftJoin(profiles, eq(profiles.id, organizationMembers.userId))
          .where(
            and(
              eq(organizationMembers.orgId, orgId),
              includeImplicit ? undefined : inArray(organizationMembers.userId, explicitIds),
            ),
          );

  const explicit = new Map(explicitRows.map((r) => [r.userId, r]));
  const out: SpaceMember[] = [];
  for (const row of orgRows) {
    const found = explicit.get(row.userId);
    const orgRole = row.role;
    const effective = resolveSpaceRole(
      orgRole,
      { id: space.id, ...spaceAccess(space) },
      found ? { ref: toRef(found) } : null,
    );
    if (!effective) continue;
    out.push({
      object: "space_member",
      userId: row.userId,
      name: row.displayName ?? row.name ?? null,
      email: row.email ?? null,
      org_role: orgRole,
      source: found ? "explicit" : orgRole === "member" ? "open_space" : "org_role",
      role: toSpaceRoleWire(effective),
      createdAt: found?.createdAt?.toISOString() ?? null,
    });
  }
  return out;
}

function spaceAccess(space: { visibility: string; defaultRole: SpaceRolePreset }) {
  return {
    visibility: space.visibility as "open" | "closed" | "private",
    defaultRole: space.defaultRole,
  };
}

/** Hold the membership lock until the caller's grant transaction commits. */
export async function lockOrgMemberForSpaceGrant(tx: DbOrTx, orgId: string, userId: string) {
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
    const target = await lockOrgMemberForSpaceGrant(tx, orgId, userId);
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

/**
 * Remove an explicit row. Returns false when there was none.
 *
 * The target bound lives here, not at the route: the row read it rests on and
 * the DELETE that acts on it must be one statement's worth of truth. The lock
 * is the grant path's — org promotion/removal take it before touching space
 * memberships — so the role asserted here cannot change under the delete.
 *
 * @throws 403 when the caller could not have granted the role being dropped.
 */
export async function removeSpaceMember(params: {
  orgId: string;
  spaceId: string;
  userId: string;
  actorPermissions: ReadonlySet<string> | undefined;
}): Promise<boolean> {
  const { orgId, spaceId, userId } = params;
  return db.transaction(async (tx) => {
    await lockOrgMemberForSpaceGrant(tx, orgId, userId);
    const existing = await loadSpaceMember(spaceId, userId, tx);
    if (!existing) return false;
    assertCanManageSpaceMember(params.actorPermissions, existing.ref);
    const deleted = await tx
      .delete(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
      .returning({ userId: spaceMembers.userId });
    return deleted.length > 0;
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
 * The FK alone would accept another org's bundle, so the org is checked here.
 *
 * Granting a bundle is the licensed half of the feature, not just defining one
 * — the gate comes before the lookup so the refusal is about the deployment
 * and says nothing about which `srl_` ids exist. Presets never ask.
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
  assertCustomRolesFeature("assign");
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
