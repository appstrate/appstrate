// SPDX-License-Identifier: Apache-2.0

import type { OrgRole } from "@appstrate/shared-types";
import { hasFullOrgAccess } from "./org-role";

interface ScheduleCaller {
  userId: string | undefined;
  orgRole: OrgRole | null;
  /** Holds `api-keys:create` in the current space. */
  canCreateApiKeys: boolean;
}

interface ScheduleActor {
  userId?: string | null;
  endUserId?: string | null;
}

/**
 * Mirrors the server's `mayGovernScheduleActor` for a signed-in member: a schedule running as
 * ANOTHER identity lends that identity's connections to every fire. Another member: an org
 * owner/admin act. An end user: whoever may borrow one, i.e. holds `api-keys:create` here.
 */
export function mayGovernScheduleActor(actor: ScheduleActor, caller: ScheduleCaller): boolean {
  if (actor.userId) return caller.userId === actor.userId || hasFullOrgAccess(caller.orgRole);
  if (actor.endUserId) return caller.canCreateApiKeys;
  return true;
}
