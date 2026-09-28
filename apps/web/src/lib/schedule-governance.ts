// SPDX-License-Identifier: Apache-2.0

import type { OrgRole } from "@appstrate/shared-types";

/** Who is asking: the signed-in user and their (effective) org role. */
interface ScheduleCaller {
  userId: string | undefined;
  orgRole: OrgRole | null;
}

/**
 * The server's `mayGovernMemberSchedule` (`apps/api/src/routes/schedules.ts`): a schedule running
 * as ANOTHER platform member lends that member's connections to every fire, so naming such an
 * actor, and any write to such a schedule, is an org owner/admin act. Running as yourself or as an
 * end user (`memberId` absent) stays a `schedules:write` matter. Only shapes what is rendered — the
 * server decides (403).
 */
export function mayGovernMemberSchedule(
  memberId: string | null | undefined,
  caller: ScheduleCaller,
): boolean {
  if (!memberId) return true;
  if (caller.userId === memberId) return true;
  return caller.orgRole === "owner" || caller.orgRole === "admin";
}

/** May `caller` edit, enable/disable or delete this stored schedule (beyond `schedules:*`)? */
export function canWriteSchedule(
  schedule: { userId: string | null | undefined },
  caller: ScheduleCaller,
): boolean {
  return mayGovernMemberSchedule(schedule.userId, caller);
}
