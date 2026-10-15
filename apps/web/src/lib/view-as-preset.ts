// SPDX-License-Identifier: Apache-2.0

import type { ViewAsOrgRole } from "@appstrate/core/permissions";
import { memberRoleValue, type RoleObject } from "../hooks/use-roles";

/** What a role's row asks the preview dialog to start from. */
export type ViewAsPreset = { kind: "org"; role: ViewAsOrgRole } | { kind: "space"; key: string };

/** The dialog's "no space" value: not the empty string, which Radix refuses as an item value. */
export const VIEW_AS_NO_SPACE = "none";

interface ViewAsSpace {
  id: string;
  visibility: "open" | "closed" | "private";
  default_role: string;
}

/**
 * The space the preview dialog shows, and the space role its preset asks for there,
 * judged in the home space. A Member reaches the home space when open, with its default
 * role; a Guest reaches nothing unasked. A picked space (even "no space") is the user's
 * own and carries no preset role. A home space the dialog does not offer (a personal
 * space) is no space.
 */
export function viewAsSpace(input: {
  preset: ViewAsPreset | null | undefined;
  homeSpaceId: string | null;
  spaces: readonly ViewAsSpace[] | undefined;
  pickedSpaceId: string | null;
}): { spaceId: string; presetRoleKey: string | undefined } {
  const { preset, spaces, pickedSpaceId } = input;
  const offered = !spaces || spaces.some((s) => s.id === input.homeSpaceId);
  const homeSpaceId = (offered && input.homeSpaceId) || VIEW_AS_NO_SPACE;
  const homeSpace = spaces?.find((s) => s.id === homeSpaceId);
  const presetSpaceId =
    preset?.kind !== "org"
      ? homeSpaceId
      : preset.role === "member" && homeSpace?.visibility === "open"
        ? homeSpace.id
        : VIEW_AS_NO_SPACE;
  if (pickedSpaceId !== null || presetSpaceId === VIEW_AS_NO_SPACE) {
    return { spaceId: pickedSpaceId ?? presetSpaceId, presetRoleKey: undefined };
  }
  return {
    spaceId: presetSpaceId,
    presetRoleKey:
      preset?.kind === "space"
        ? preset.key
        : preset?.kind === "org"
          ? homeSpace?.default_role
          : undefined,
  };
}

export function viewAsRoleValue(
  presetRoleKey: string | undefined,
  pickedRole: string | null,
  roles: RoleObject[] | undefined,
): string {
  if (pickedRole !== null) return pickedRole;
  const presetRole = presetRoleKey ? roles?.find((r) => r.key === presetRoleKey) : undefined;
  return memberRoleValue(presetRole ?? null, roles) ?? "";
}
