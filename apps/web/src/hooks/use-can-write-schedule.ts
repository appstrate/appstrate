// SPDX-License-Identifier: Apache-2.0

import { useAuth } from "./use-auth";
import { usePermissions } from "./use-permissions";
import { canWriteSchedule } from "../lib/schedule-governance";

/**
 * Whether this caller may edit, toggle or delete `schedule` beyond `schedules:write`/`delete`: a
 * schedule running as another member is an org owner/admin matter ({@link canWriteSchedule}).
 * `false` while the schedule is not loaded.
 */
export function useCanWriteSchedule(schedule: { userId: string | null } | undefined): boolean {
  const { user } = useAuth();
  const { orgRole } = usePermissions();
  return !!schedule && canWriteSchedule(schedule, { userId: user?.id, orgRole });
}
