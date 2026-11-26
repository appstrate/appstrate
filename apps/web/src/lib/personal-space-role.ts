// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from "i18next";
import { isSpaceRolePreset } from "@appstrate/core/permissions";
import type { components } from "../api/client";
import {
  spaceRoleAssignment,
  spaceRoleLabel,
  spaceRoleValue,
  type SpaceRolePreset,
} from "../hooks/use-roles";

type OrgMember = components["schemas"]["OrgMember"];

/** The select value of « selon l'organisation »: no override of the member's own. */
export const FOLLOW_ORG_DEFAULT = "org-default";

/** The default of an organization that never set `personal_space_role`. */
const DEFAULT_STORED_ROLE = "admin";

/** A stored org setting is a preset key or a custom role id (`srl_…`); a select carries `preset:<key>` / `custom:<id>`. */
export function storedRoleToSelectValue(stored: string | undefined): string {
  const key = stored || DEFAULT_STORED_ROLE;
  return isSpaceRolePreset(key)
    ? spaceRoleValue({ preset_role: key })
    : spaceRoleValue({ custom_role_id: key });
}

/**
 * What « selon l'organisation » resolves to for a member: the role the server reports
 * (`personal_space_default_role`, guest cap applied), named as the role selects name it. `null`
 * when the org default names no role of the organization: the setting is invalid, said so.
 */
export function followLabel(member: OrgMember, t: (key: string) => string): string {
  return (
    spaceRoleLabel(member.personal_space_default_role, t) ??
    t("settings:userDetail.personalSpaceRoleNoDefault")
  );
}

/** The org setting's PATCH body for a picked select value. */
export function orgPersonalSpaceRoleBody(selectValue: string): { personal_space_role: string } {
  const { preset_role, custom_role_id } = spaceRoleAssignment(selectValue);
  return { personal_space_role: (preset_role ?? custom_role_id) as string };
}

/** What a member's own override reads as in the select. */
export function memberOverrideToSelectValue(role: OrgMember["personal_space_role"]): string {
  if (!role) return FOLLOW_ORG_DEFAULT;
  return "preset_role" in role
    ? spaceRoleValue({ preset_role: role.preset_role })
    : spaceRoleValue({ custom_role_id: role.custom_role_id });
}

export type MemberPersonalSpaceRoleRequest =
  | { method: "DELETE" }
  | {
      method: "PUT";
      body: { preset_role: SpaceRolePreset } | { custom_role_id: string };
    };

/** The first option clears the override; any other sets it, with exactly one of the two body fields. */
export function memberPersonalSpaceRoleRequest(
  selectValue: string,
): MemberPersonalSpaceRoleRequest {
  if (selectValue === FOLLOW_ORG_DEFAULT) return { method: "DELETE" };
  const { preset_role, custom_role_id } = spaceRoleAssignment(selectValue);
  return {
    method: "PUT",
    body: preset_role ? { preset_role } : { custom_role_id: custom_role_id as string },
  };
}

/** What a candidate org default would stop: `GET /api/orgs/{orgId}/personal-space-role/impact`. */
export interface PersonalSpaceRoleImpact {
  schedules: number;
  members: number;
}

/** A pick of the org default held until the admin confirms it. */
export interface PendingPersonalSpaceRole {
  selectValue: string;
  impact: PersonalSpaceRoleImpact;
}

/**
 * A pick of the org's personal-space default: its impact is read first. A pick that would disable
 * schedules is held for confirmation (`askConfirmation`); any other is written at once. A failed
 * read writes nothing and rejects with its error.
 */
export async function pickPersonalSpaceRole(
  selectValue: string,
  steps: {
    impactOf: (role: string) => Promise<PersonalSpaceRoleImpact>;
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
