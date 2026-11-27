// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from "i18next";
import type { components } from "../api/client";
import type { operations } from "../api/schema";
import {
  spaceRoleAssignment,
  spaceRoleLabel,
  catalogRoleValue,
  spaceRoleValue,
  type RoleObject,
  type SpaceRoleReference,
} from "../hooks/use-roles";

type OrgMember = components["schemas"]["OrgMember"];

/** The select value of « selon l'organisation »: no override of the member's own. */
export const FOLLOW_ORG_DEFAULT = "org-default";

/**
 * What « selon l'organisation » resolves to for a member (`personal_space_default_role`, guest cap
 * applied), named as the role selects name it, or said invalid when it names no role.
 */
export function followLabel(member: OrgMember, t: (key: string) => string): string {
  const role = member.personal_space_default_role;
  if (!role) return t("settings:userDetail.personalSpaceRoleNoDefault");
  return spaceRoleLabel(role, t) ?? role.name;
}

/** The org setting's PATCH body for a picked select value. */
export function orgPersonalSpaceRoleBody(selectValue: string): {
  personal_space_role: SpaceRoleReference;
} {
  return { personal_space_role: spaceRoleAssignment(selectValue) };
}

/** What a member's own override reads as in the select. */
export function memberOverrideToSelectValue(role: OrgMember["personal_space_role"]): string {
  return role ? spaceRoleValue(role) : FOLLOW_ORG_DEFAULT;
}

export type MemberPersonalSpaceRoleRequest =
  { method: "DELETE" } | { method: "PUT"; body: SpaceRoleReference };

/** The first option clears the override; any other sets it, with exactly one of the two body fields. */
export function memberPersonalSpaceRoleRequest(
  selectValue: string,
): MemberPersonalSpaceRoleRequest {
  if (selectValue === FOLLOW_ORG_DEFAULT) return { method: "DELETE" };
  return { method: "PUT", body: spaceRoleAssignment(selectValue) };
}

/**
 * The select values a guest may pick: the roles granting nothing beyond `operator`, where the
 * server caps a guest's role anyway.
 */
export function guestRoleValues(
  roles: Pick<RoleObject, "id" | "kind" | "key" | "permissions">[] | undefined,
): Set<string> {
  const operator = new Set(
    roles?.find((r) => r.kind === "preset" && r.key === "operator")?.permissions,
  );
  return new Set(
    (roles ?? [])
      .filter((r) => r.permissions.every((permission) => operator.has(permission)))
      .map(catalogRoleValue),
  );
}

type PersonalSpaceRoleImpact =
  operations["getPersonalSpaceRoleImpact"]["responses"][200]["content"]["application/json"];

/** A pick of the org default held until the admin confirms it. */
export interface PendingPersonalSpaceRole {
  selectValue: string;
  impact: PersonalSpaceRoleImpact;
}

/**
 * A pick of the org's personal-space default: one that would disable schedules is held for
 * confirmation, any other written at once. A failed impact read writes nothing and rejects.
 */
export async function pickPersonalSpaceRole(
  selectValue: string,
  steps: {
    impactOf: (role: SpaceRoleReference) => Promise<PersonalSpaceRoleImpact>;
    write: (selectValue: string) => void;
    askConfirmation: (pending: PendingPersonalSpaceRole) => void;
  },
): Promise<void> {
  const impact = await steps.impactOf(orgPersonalSpaceRoleBody(selectValue).personal_space_role);
  if (impact.schedules > 0) steps.askConfirmation({ selectValue, impact });
  else steps.write(selectValue);
}

/** The confirmation's sentence: how many schedules of how many members stop, and that it is not undone. */
export function personalSpaceRoleImpactDescription(
  t: TFunction,
  impact: PersonalSpaceRoleImpact,
): string {
  return t("settings:orgSettings.personalSpaceRoleImpactDesc", {
    count: impact.schedules,
    schedules: t("settings:orgSettings.personalSpaceRoleImpactSchedules", {
      count: impact.schedules,
    }),
    members: t("settings:orgSettings.personalSpaceRoleImpactMembers", { count: impact.members }),
  });
}
