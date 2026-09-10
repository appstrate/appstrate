// SPDX-License-Identifier: Apache-2.0

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spaceMembers, spaceRoles, spaces } from "@appstrate/db/schema";
import type { SpaceAssignment } from "@appstrate/core/permissions";
import type { AssignableOrgRole } from "@appstrate/shared-types";
import { invalidRequest, notFound } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";
import { lockOrgMemberForSpaceGrant } from "./space-members.ts";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Validate deferred grants before saving an invitation or OAuth signup policy.
 * Admins need no explicit grants; guests need at least one. All referenced
 * spaces and custom roles must belong to the organization.
 */
export async function assertSpaceAssignmentsValid(
  params: {
    orgId: string;
    role: AssignableOrgRole;
    assignments: ReadonlyArray<SpaceAssignment>;
    param?: string;
  },
  tx: DbOrTx = db,
): Promise<void> {
  const { orgId, role, assignments, param = "space_assignments" } = params;
  if (role === "admin" && assignments.length > 0) {
    throw invalidRequest(
      `Admins already run every space in the organization; ${param} must be empty`,
      param,
    );
  }
  if (role === "guest" && assignments.length === 0) {
    throw invalidRequest(
      `A guest has no implicit space access; ${param} must name at least one space`,
      param,
    );
  }
  if (assignments.length === 0) return;

  const spaceIds = [...new Set(assignments.map((a) => a.space_id))];
  const liveSpaces = await tx
    .select({ id: spaces.id, ownerUserId: spaces.ownerUserId })
    .from(spaces)
    .where(and(eq(spaces.orgId, orgId), inArray(spaces.id, spaceIds)));
  const found = new Set(liveSpaces.map((row) => row.id));
  const missingSpace = spaceIds.find((id) => !found.has(id));
  if (missingSpace) throw notFound(`Space '${missingSpace}' not found in this organization`);
  // A personal space belongs to one member and takes no others (RBAC spec
  // §3.6), so it is never assignable — an invitation or an SSO signup policy
  // naming one is a configuration error, refused where it is written rather
  // than silently dropped when the member arrives.
  const personal = liveSpaces.find((row) => row.ownerUserId !== null);
  if (personal) {
    throw invalidRequest(
      `Space '${personal.id}' is a personal space and cannot be assigned to anyone`,
      param,
    );
  }

  const roleIds = [
    ...new Set(assignments.map((a) => a.custom_role_id).filter((id): id is string => Boolean(id))),
  ];
  if (roleIds.length === 0) return;
  const liveRoles = await tx
    .select({ id: spaceRoles.id })
    .from(spaceRoles)
    .where(and(eq(spaceRoles.orgId, orgId), inArray(spaceRoles.id, roleIds)));
  const foundRoles = new Set(liveRoles.map((row) => row.id));
  const missingRole = roleIds.find((id) => !foundRoles.has(id));
  if (missingRole) throw notFound(`Space role '${missingRole}' not found in this organization`);
}

/**
 * Apply deferred grants inside the caller's membership transaction, returning
 * the assignments actually written. Invitations skip deleted targets; OAuth
 * signup rejects stale policy so a new member never receives partial access.
 */
export async function applySpaceAssignments(
  tx: DbOrTx,
  params: {
    orgId: string;
    userId: string;
    addedBy: string | null;
    assignments: ReadonlyArray<SpaceAssignment>;
    onMissing: "skip" | "reject";
  },
): Promise<SpaceAssignment[]> {
  const { orgId, userId, addedBy, assignments } = params;
  if (assignments.length === 0) return [];

  // An existing member may have been promoted since the grants were configured.
  const member = await lockOrgMemberForSpaceGrant(tx, orgId, userId);
  if (!member) throw notFound("User is not a member of this organization");
  const orgRole = member.role;
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
          // Backstop on the WRITE side of "a personal space is never
          // assignable" (RBAC spec §3.6). `assertSpaceAssignmentsValid`
          // already refuses one when the invitation or the signup policy is
          // saved, and `owner_user_id` is only ever set at creation, so a
          // stored policy cannot come to name a personal space on its own —
          // but this is the statement that would grant the access, so it is
          // where the rule has to hold. Excluded rather than special-cased, so
          // such a target takes the existing "no longer exists" path: skipped
          // for an invitation, refused for an SSO signup.
          isNull(spaces.ownerUserId),
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
      if (params.onMissing === "reject") {
        throw notFound(`Configured space assignment references a ${gone} that no longer exists`);
      }
      logger.warn(`Invitation space assignment skipped — ${gone} no longer exists`, {
        orgId,
        userId,
        assignment,
      });
      continue;
    }
    // Preconditions already proved once for the whole batch above. Re-proving
    // per assignment would be a third round-trip for an answer in hand.
    const values = assignment.preset_role
      ? { presetRole: assignment.preset_role, customRoleId: null }
      : { presetRole: null, customRoleId: assignment.custom_role_id! };
    await tx
      .insert(spaceMembers)
      .values({ spaceId: assignment.space_id, userId, addedBy, ...values })
      .onConflictDoUpdate({ target: [spaceMembers.spaceId, spaceMembers.userId], set: values });
    applied.push(assignment);
  }
  return applied;
}
