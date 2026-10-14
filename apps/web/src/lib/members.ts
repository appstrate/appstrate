// SPDX-License-Identifier: Apache-2.0

import type { components } from "../api/client";

export type OrgMember = components["schemas"]["OrgMember"];

/** A member's name on screen: their display name, else their address, else their id. */
export function memberLabel(member: OrgMember): string {
  return member.displayName || member.email || member.userId;
}
