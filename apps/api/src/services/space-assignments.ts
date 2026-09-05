// SPDX-License-Identifier: Apache-2.0

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spaceMembers, spaceRoles, spaces } from "@appstrate/db/schema";
import type { SpaceAssignment } from "@appstrate/core/permissions";
import type { AssignableOrgRole } from "@appstrate/shared-types";
import { invalidRequest, notFound } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";
import { getOrgMember } from "./organizations.ts";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Validate the space assignments an invite body carries, at invite time.
 *
 * The two role rules are refusals about the ROLE, not about the list: an
 * `admin` never holds a `space_members` row (the space-members route answers
 * 409 for the same reason), and a `guest` has no implicit reach anywhere, so
 * inviting one with no space is inviting someone who can see nothing.
 *
 * The existence checks are what stop an invitation from carrying another org's
 * space or role id — the FK would accept the latter and the accept path has no
 * org to check it against by then.
 *
 * @throws 400 on either role rule; 404 naming the space or role that is not
 *   this org's.
 */
export async function assertSpaceAssignmentsValid(params: {
  orgId: string;
  role: AssignableOrgRole;
  assignments: ReadonlyArray<SpaceAssignment>;
}): Promise<void> {
  const { orgId, role, assignments } = params;
  if (role === "admin" && assignments.length > 0) {
    throw invalidRequest(
      "Admins already run every space in the organization; space_assignments must be empty",
      "space_assignments",
    );
  }
  if (role === "guest" && assignments.length === 0) {
    throw invalidRequest(
      "A guest has no implicit space access; space_assignments must name at least one space",
      "space_assignments",
    );
  }
  if (assignments.length === 0) return;

  const spaceIds = [...new Set(assignments.map((a) => a.space_id))];
  const liveSpaces = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.orgId, orgId), inArray(spaces.id, spaceIds)));
  const found = new Set(liveSpaces.map((row) => row.id));
  const missingSpace = spaceIds.find((id) => !found.has(id));
  if (missingSpace) throw notFound(`Space '${missingSpace}' not found in this organization`);

  const roleIds = [
    ...new Set(assignments.map((a) => a.custom_role_id).filter((id): id is string => Boolean(id))),
  ];
  if (roleIds.length === 0) return;
  const liveRoles = await db
    .select({ id: spaceRoles.id })
    .from(spaceRoles)
    .where(and(eq(spaceRoles.orgId, orgId), inArray(spaceRoles.id, roleIds)));
  const foundRoles = new Set(liveRoles.map((row) => row.id));
  const missingRole = roleIds.find((id) => !foundRoles.has(id));
  if (missingRole) throw notFound(`Space role '${missingRole}' not found in this organization`);
}

/**
 * Apply an invitation's assignments inside the accept transaction, returning
 * those actually written for the audit payload.
 *
 * A space or custom role deleted between invite and accept is SKIPPED, not
 * fatal: refusing would strand the invitee outside the org with a token already
 * spent. The warn line is the record that a granted role was not applied.
 */
export async function applySpaceAssignments(
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
  const orgRole = (await getOrgMember(orgId, userId, tx))?.role;
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
