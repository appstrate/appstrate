// SPDX-License-Identifier: Apache-2.0

import type { components } from "../api/client";

export type OrgMember = components["schemas"]["OrgMember"];

/**
 * A member's name on screen: their name, else their address, else their id.
 * The org list names a member `displayName`, a space's list `name`.
 */
export function memberLabel<
  M extends {
    displayName?: string | null;
    name?: string | null;
    email?: string | null;
    userId: string;
  },
>(member: M): string {
  return member.displayName || member.name || member.email || member.userId;
}

/** An end-user's name on screen: their name, else their address, else their external id, else `fallback`. */
export function endUserLabel(
  endUser: { name?: string | null; email?: string | null; externalId?: string | null },
  fallback: string,
): string {
  return endUser.name || endUser.email || endUser.externalId || fallback;
}
