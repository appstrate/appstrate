// SPDX-License-Identifier: Apache-2.0

import { useAuth } from "./use-auth";
import { usePermissions } from "./use-permissions";
import { mayGovernMemberSchedule } from "../lib/schedule-governance";

/** {@link mayGovernMemberSchedule} for a loaded schedule; `false` while it is not. */
export function useCanWriteSchedule(schedule: { userId: string | null } | undefined): boolean {
  const { user } = useAuth();
  const { orgRole } = usePermissions();
  return !!schedule && mayGovernMemberSchedule(schedule.userId, { userId: user?.id, orgRole });
}
