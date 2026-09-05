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
import type { OrgRole, SpaceAssignment, SpaceRolePreset } from "@appstrate/core/permissions";
import type { SpaceMember } from "@appstrate/shared-types";
import { conflict, notFound } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";
import { getOrgMember } from "./organizations.ts";
import { resolveSpaceRole, toRef, toSpaceRoleWire } from "../lib/space-role.ts";
import { assertCanGrantSpaceRole } from "../lib/space-role-policy.ts";

/** Accepts either the base client or an open transaction handle. */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** One row of `GET /api/spaces/:id/members` — the wire shape, from shared-types. */
export type SpaceMemberWire = SpaceMember;

/** Assignment as the write routes accept it: one preset, or one custom role id. */
export type SpaceRoleAssignment = { preset_role: SpaceRolePreset } | { custom_role_id: string };

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
): Promise<SpaceMemberWire[]> {
  const [orgRows, explicitRows] = await Promise.all([
    db
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
      .where(eq(organizationMembers.orgId, orgId)),
    db
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
      .where(eq(spaceMembers.spaceId, space.id)),
  ]);

  const explicit = new Map(explicitRows.map((r) => [r.userId, r]));
  const out: SpaceMemberWire[] = [];
  for (const row of orgRows) {
    const found = explicit.get(row.userId);
    if (!found && !includeImplicit) continue;
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
      created_at: found?.createdAt?.toISOString() ?? null,
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
  const targetRole = await orgRoleOf(db, orgId, userId);
  if (!targetRole) throw notFound("User is not a member of this organization");
  if (targetRole === "owner" || targetRole === "admin") {
    throw conflict(
      "redundant_space_role",
      `${targetRole}s already run every space in the organization; an explicit role would grant nothing`,
    );
  }
  const memberFilter = and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId));
  if (!params.requireExisting) {
    const [existing] = await db
      .select({ userId: spaceMembers.userId })
      .from(spaceMembers)
      .where(memberFilter)
      .limit(1);
    if (existing) throw existingSpaceMember();
  }
  const values = await assignmentColumns(orgId, assignment, params.actorPermissions);

  if (params.requireExisting) {
    const updated = await db
      .update(spaceMembers)
      .set(values)
      .where(memberFilter)
      .returning({ userId: spaceMembers.userId });
    if (updated.length === 0) throw notFound("Space member not found");
    return;
  }

  const inserted = await db
    .insert(spaceMembers)
    .values({ spaceId, userId, addedBy, ...values })
    .onConflictDoNothing({ target: [spaceMembers.spaceId, spaceMembers.userId] })
    .returning({ userId: spaceMembers.userId });
  if (inserted.length === 0) throw existingSpaceMember();
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
 * Invitation application runs in its claim transaction, after validating the
 * org membership and the live assignment targets once for the whole batch.
 */
async function writeSpaceMemberRow(
  tx: DbOrTx,
  row: { spaceId: string; userId: string; addedBy: string | null; values: RoleColumns },
): Promise<void> {
  await tx
    .insert(spaceMembers)
    .values({ spaceId: row.spaceId, userId: row.userId, addedBy: row.addedBy, ...row.values })
    .onConflictDoUpdate({
      target: [spaceMembers.spaceId, spaceMembers.userId],
      set: row.values,
    });
}

/**
 * Apply an invitation's assignments inside the accept transaction, returning
 * those actually written for the audit payload.
 *
 * A space or custom role deleted between invite and accept is SKIPPED, not
 * fatal: refusing would strand the invitee outside the org with a token already
 * spent. The warn line is the record that a granted role was not applied.
 */
export async function applyInvitationSpaceAssignments(
  tx: DbOrTx,
  params: {
    orgId: string;
    userId: string;
    addedBy: string | null;
    assignments: ReadonlyArray<SpaceAssignment>;
  },
): Promise<SpaceAssignment[]> {
  const { orgId, userId, addedBy, assignments } = params;
  if (assignments.length === 0) return [];

  // An idempotent accept keeps the existing membership row, so the invitation's
  // role is not necessarily the role the user ends up with.
  const orgRole = await orgRoleOf(tx, orgId, userId);
  if (orgRole === "owner" || orgRole === "admin") {
    logger.warn("Invitation space assignments skipped for an org admin", {
      orgId,
      userId,
      orgRole,
      count: assignments.length,
    });
    return [];
  }

  const namedRoles = [
    ...new Set(assignments.map((a) => a.custom_role_id).filter((id): id is string => Boolean(id))),
  ];
  const [liveSpaces, liveRoles] = await Promise.all([
    tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(
        and(
          eq(spaces.orgId, orgId),
          inArray(spaces.id, [...new Set(assignments.map((a) => a.space_id))]),
        ),
      ),
    namedRoles.length === 0
      ? Promise.resolve([] as { id: string }[])
      : tx
          .select({ id: spaceRoles.id })
          .from(spaceRoles)
          .where(and(eq(spaceRoles.orgId, orgId), inArray(spaceRoles.id, namedRoles))),
  ]);
  const spaceIds = new Set(liveSpaces.map((row) => row.id));
  const roleIds = new Set(liveRoles.map((row) => row.id));

  const applied: SpaceAssignment[] = [];
  for (const assignment of assignments) {
    const gone = !spaceIds.has(assignment.space_id)
      ? "space"
      : assignment.custom_role_id && !roleIds.has(assignment.custom_role_id)
        ? "custom role"
        : null;
    if (gone) {
      logger.warn(`Invitation space assignment skipped — ${gone} no longer exists`, {
        orgId,
        userId,
        assignment,
      });
      continue;
    }
    // Preconditions already proved once for the whole batch above. Re-proving
    // per assignment would be a third round-trip for an answer in hand.
    await writeSpaceMemberRow(tx, {
      spaceId: assignment.space_id,
      userId,
      addedBy,
      values: assignment.preset_role
        ? { presetRole: assignment.preset_role, customRoleId: null }
        : { presetRole: null, customRoleId: assignment.custom_role_id! },
    });
    applied.push(assignment);
  }
  return applied;
}

/** Remove an explicit row. Returns false when there was none. */
export async function removeSpaceMember(spaceId: string, userId: string): Promise<boolean> {
  const deleted = await db
    .delete(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
    .returning({ userId: spaceMembers.userId });
  return deleted.length > 0;
}

/**
 * Called on promotion to admin/owner, in the same transaction as the role
 * change: the rows become dead weight, and a later demotion must not silently
 * restore a role nobody re-granted.
 */
export async function deleteSpaceMembershipsInOrg(
  tx: Pick<typeof db, "select" | "delete">,
  orgId: string,
  userId: string,
): Promise<void> {
  const orgSpaces = await tx.select({ id: spaces.id }).from(spaces).where(eq(spaces.orgId, orgId));
  if (orgSpaces.length === 0) return;
  await tx.delete(spaceMembers).where(
    and(
      eq(spaceMembers.userId, userId),
      inArray(
        spaceMembers.spaceId,
        orgSpaces.map((s) => s.id),
      ),
    ),
  );
}

async function orgRoleOf(tx: DbOrTx, orgId: string, userId: string): Promise<OrgRole | null> {
  const row = await getOrgMember(orgId, userId, tx);
  return row ? row.role : null;
}

/** The FK alone would accept another org's bundle, so the org is checked here. */
async function assignmentColumns(
  orgId: string,
  assignment: SpaceRoleAssignment,
  actorPermissions: ReadonlySet<string> | undefined,
): Promise<RoleColumns> {
  if ("preset_role" in assignment) {
    assertCanGrantSpaceRole(actorPermissions, { kind: "preset", preset: assignment.preset_role });
    return { presetRole: assignment.preset_role, customRoleId: null };
  }
  const [role] = await db
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
