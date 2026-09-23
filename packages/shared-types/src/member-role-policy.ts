// SPDX-License-Identifier: Apache-2.0

import { ORG_ROLES, type OrgRole } from "@appstrate/core/permissions";

/**
 * Roles an invitation or an OIDC `signupRole` may grant. `owner` is absent on
 * purpose: ownership is only ever reached by a role CHANGE, by an owner, on
 * someone who is already a member.
 */
export const ASSIGNABLE_ORG_ROLES = ["guest", "member", "admin"] as const;
export type AssignableOrgRole = (typeof ASSIGNABLE_ORG_ROLES)[number];

type MissingAssignableOrgRole = Exclude<Exclude<OrgRole, "owner">, AssignableOrgRole>;
const assertAssignableOrgRolesExhaustive: MissingAssignableOrgRole extends never ? true : never =
  true;
void assertAssignableOrgRolesExhaustive;

interface MemberPolicyContext {
  actorRole: OrgRole;
  targetRole: OrgRole;
  isSelf: boolean;
}

// Nobody manages themselves (an owner steps down by asking another owner, or
// by leaving); only an owner touches an owner.
function canManageMember({ actorRole, targetRole, isSelf }: MemberPolicyContext): boolean {
  if (isSelf) return false;
  if (actorRole === "owner") return true;
  if (targetRole === "owner") return false;
  return actorRole === "admin" && (targetRole === "guest" || targetRole === "member");
}

export function assignableRolesForMember(context: MemberPolicyContext): readonly OrgRole[] {
  if (!canManageMember(context)) return [];
  return context.actorRole === "owner" ? ORG_ROLES : ASSIGNABLE_ORG_ROLES;
}

export function canRemoveMember(context: MemberPolicyContext): boolean {
  return canManageMember(context);
}

/**
 * Whether a member may leave: the last owner may not. Advisory (button state) —
 * the server re-decides under the org's ownership lock.
 */
export function canLeaveOrg({ role, ownerCount }: { role: OrgRole; ownerCount: number }): boolean {
  return role !== "owner" || ownerCount > 1;
}
