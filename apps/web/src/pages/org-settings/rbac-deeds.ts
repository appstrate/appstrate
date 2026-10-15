// SPDX-License-Identifier: Apache-2.0

/** What the two RBAC pages offer, from permissions alone; plain functions because the menus are closed in a static render. */
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

/** Only an explicit seat can go; for a standard member of an OPEN space it resets to the default role instead of cutting access. */
export function spaceMemberRemoval(
  member: Pick<SpaceMember, "source" | "org_role">,
  { canRemove, visibility }: { canRemove: boolean; visibility: SpaceVisibility | undefined },
): "reset" | "remove" | null {
  if (member.source !== "explicit" || !canRemove) return null;
  return member.org_role === "member" && visibility === "open" ? "reset" : "remove";
}
