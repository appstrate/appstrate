// SPDX-License-Identifier: Apache-2.0

import type { OrgRole } from "@appstrate/shared-types";
import { hasFullOrgAccess } from "./org-role";

/** Who is asking: the signed-in user and their (effective) org role. */
interface ScheduleCaller {
  userId: string | undefined;
  orgRole: OrgRole | null;
}

/**
 * Mirrors the server's `mayGovernScheduleActor` for a signed-in member: a schedule running as
 * ANOTHER identity (member or end user) lends that identity's connections to every fire, so
 * naming or writing it is an org owner/admin act. `actorId` is the schedule's `userId` or
 * `endUserId`.
 */
export function mayGovernScheduleActor(
  actorId: string | null | undefined,
  caller: ScheduleCaller,
): boolean {
  if (!actorId) return true;
  if (caller.userId === actorId) return true;
  return hasFullOrgAccess(caller.orgRole);
}
