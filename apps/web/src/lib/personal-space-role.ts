// SPDX-License-Identifier: Apache-2.0

import { isSpaceRolePreset } from "@appstrate/core/permissions";
import type { components } from "../api/client";
import {
  spaceRoleAssignment,
  spaceRoleValue,
  type RoleObject,
  type SpaceRoleOption,
  type SpaceRolePreset,
} from "../hooks/use-roles";

type OrgMember = components["schemas"]["OrgMember"];

/** The select value of « selon l'organisation »: no override of the member's own. */
export const FOLLOW_ORG_DEFAULT = "org-default";

/** The default of an organization that never set `personal_space_role`. */
const DEFAULT_STORED_ROLE = "admin";

/** A stored org setting is a preset key or a custom role id (`srl_…`); a select carries `preset:<key>` / `custom:<id>`. */
export function storedRoleToSelectValue(stored: unknown): string {
  const key = typeof stored === "string" && stored ? stored : DEFAULT_STORED_ROLE;
  return isSpaceRolePreset(key)
    ? spaceRoleValue({ preset_role: key })
    : spaceRoleValue({ custom_role_id: key });
}

/**
 * What « selon l'organisation » resolves to: the org setting — for a guest too, unless it lets
 * them author agents (`agents:write`), in which case a guest holds `operator`. Judged on the
 * catalogue entry's permissions; before the catalogue answers, on the authoring presets.
 */
export function followLabel(
  member: OrgMember,
  options: SpaceRoleOption[],
  stored: unknown,
  unknown: string,
  roles?: readonly Pick<RoleObject, "kind" | "key" | "id" | "permissions">[],
): string {
  const value = storedRoleToSelectValue(stored);
  const entry = roles?.find(
    (role) =>
      spaceRoleValue({
        preset_role: role.kind === "preset" ? role.key : null,
        custom_role_id: role.id,
      }) === value,
  );
  const authors = entry
    ? entry.permissions.includes("agents:write")
    : value === spaceRoleValue({ preset_role: "admin" }) ||
      value === spaceRoleValue({ preset_role: "builder" });
  const shown =
    member.role === "guest" && authors ? spaceRoleValue({ preset_role: "operator" }) : value;
  return options.find((option) => option.value === shown)?.label ?? unknown;
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
