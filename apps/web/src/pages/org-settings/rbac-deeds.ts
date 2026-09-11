// SPDX-License-Identifier: Apache-2.0

/**
 * What the two RBAC pages offer, decided from permissions alone.
 *
 * The deeds live in a closed menu and a row's removal lives in a closed menu,
 * so a static render never shows them. The decisions are kept here, as plain
 * functions, where they can be read and tested without opening anything.
 */
import type { components } from "../../api/schema";

type SpaceMember = components["schemas"]["SpaceMemberObject"];
type SpaceVisibility = components["schemas"]["SpaceObject"]["visibility"];

/** The roles page's deeds, in menu order: authoring a role, then previewing one. */
export function rolesPageDeeds({
  canWrite,
  canPreview,
}: {
  canWrite: boolean;
  canPreview: boolean;
}): ("create" | "view-as")[] {
  return [
    ...(canWrite ? (["create"] as const) : []),
    ...(canPreview ? (["view-as"] as const) : []),
  ];
}

/** The space members page's deeds, in menu order: adding someone, then previewing a role. */
export function spaceMembersPageDeeds({
  canInvite,
  canPreview,
}: {
  canInvite: boolean;
  canPreview: boolean;
}): ("add" | "view-as")[] {
  return [...(canInvite ? (["add"] as const) : []), ...(canPreview ? (["view-as"] as const) : [])];
}

/**
 * What removing a member's seat does. Only an explicit seat can go. For a
 * standard member of an OPEN space it restores the space's default role
 * rather than cutting access, which is why the deed is named for that.
 */
export function spaceMemberRemoval(
  member: Pick<SpaceMember, "source" | "org_role">,
  { canRemove, visibility }: { canRemove: boolean; visibility: SpaceVisibility | undefined },
): "reset" | "remove" | null {
  if (member.source !== "explicit" || !canRemove) return null;
  return member.org_role === "member" && visibility === "open" ? "reset" : "remove";
}
