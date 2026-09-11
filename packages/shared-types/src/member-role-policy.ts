// SPDX-License-Identifier: Apache-2.0

import type { OrgRole } from "@appstrate/core/permissions";

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

function canManageMember({ actorRole, targetRole, isSelf }: MemberPolicyContext): boolean {
  if (isSelf || targetRole === "owner") return false;
  if (actorRole === "owner") return true;
  return actorRole === "admin" && (targetRole === "guest" || targetRole === "member");
}

export function assignableRolesForMember(
  context: MemberPolicyContext,
): readonly AssignableOrgRole[] {
  return canManageMember(context) ? ASSIGNABLE_ORG_ROLES : [];
}

export function canRemoveMember(context: MemberPolicyContext): boolean {
  return canManageMember(context);
}
