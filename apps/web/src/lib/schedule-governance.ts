// SPDX-License-Identifier: Apache-2.0

import type { OrgRole } from "@appstrate/shared-types";
import { hasFullOrgAccess } from "./org-role";

/** Who is asking: the signed-in user and their (effective) org role. */
interface ScheduleCaller {
  userId: string | undefined;
  orgRole: OrgRole | null;
}

/**
 * Mirrors the server's `mayGovernMemberSchedule`: a schedule running as ANOTHER member lends
 * that member's connections to every fire, so naming or writing it is an org owner/admin act.
 */
export function mayGovernMemberSchedule(
  memberId: string | null | undefined,
  caller: ScheduleCaller,
): boolean {
  if (!memberId) return true;
  if (caller.userId === memberId) return true;
  return hasFullOrgAccess(caller.orgRole);
}
