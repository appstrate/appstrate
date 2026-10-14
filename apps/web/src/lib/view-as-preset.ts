// SPDX-License-Identifier: Apache-2.0

import { VIEW_AS_ORG_ROLES, type ViewAsOrgRole } from "@appstrate/core/permissions";
import { memberRoleValue, type RoleObject } from "../hooks/use-roles";

/**
 * What a role's own row asks the preview dialog to start from, carried in the
 * address (`?viewAs=org:member`, `?viewAs=space:viewer`) so the dialog opened
 * from a row keeps a URL that reopens it pre-filled.
 */
export type ViewAsPreset = { kind: "org"; role: ViewAsOrgRole } | { kind: "space"; key: string };

export function viewAsPresetParam(preset: ViewAsPreset): string {
  return preset.kind === "org" ? `org:${preset.role}` : `space:${preset.key}`;
}

/** `null` for the bare `?view-as` of the page's Actions menu, and for anything unreadable. */
export function parseViewAsPreset(raw: string | null): ViewAsPreset | null {
  if (!raw) return null;
  const separator = raw.indexOf(":");
  const kind = raw.slice(0, separator);
  const key = raw.slice(separator + 1);
  if (separator === -1 || !key) return null;
  if (kind === "space") return { kind, key };
  const role = VIEW_AS_ORG_ROLES.find((r) => r === key);
  return kind === "org" && role ? { kind, role } : null;
}

/** The dialog's "no space" value: not the empty string, which Radix refuses as an item value. */
export const VIEW_AS_NO_SPACE = "none";

interface ViewAsSpace {
  id: string;
  visibility: "open" | "closed" | "private";
  default_role: string;
}

/**
 * The space the preview dialog shows, and the space role its preset asks for there. A space role
 * is judged in the home space (the one the page is about). A Member reaches the open spaces
 * unasked, with the role each gives its members: the home space when open, with its default role.
 * A Guest reaches nothing unasked, hence no space. A picked space (`pickedSpaceId` not `null`),
 * even "no space", is the user's own and carries no preset role. A home space the dialog does not
 * offer (someone's personal space) is no space at all.
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

/** The role select's value: the user's pick (`null` until one), else the preset's, else none. */
export function viewAsRoleValue(
  presetRoleKey: string | undefined,
  pickedRole: string | null,
  roles: RoleObject[] | undefined,
): string {
  if (pickedRole !== null) return pickedRole;
  const presetRole = presetRoleKey ? roles?.find((r) => r.key === presetRoleKey) : undefined;
  return memberRoleValue(presetRole ?? null, roles) ?? "";
}
