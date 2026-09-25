// SPDX-License-Identifier: Apache-2.0

import {
  canReadRuns,
  packageSightPermissions,
  type CorePermission,
} from "@appstrate/core/permissions";

/** Which dashboard sections the caller can read — each one is its own read. */
export interface DashboardSections {
  schedules: boolean;
  recentAgents: boolean;
  recentRuns: boolean;
}

/**
 * The dashboard is the fallback route: it renders for ANY principal, so each
 * section answers to the guard of the query that feeds it (#1556). Pure: the
 * API's preset pin (`apps/api/test/unit/spa-dashboard-sections.test.ts`) imports it.
 */
export function dashboardSections(can: (permission: CorePermission) => boolean): DashboardSections {
  const runs = canReadRuns(can);
  return {
    schedules: can("schedules:read"),
    // Picked out of the recent runs, then named from the agent index.
    recentAgents: runs && packageSightPermissions("agent").some(can),
    recentRuns: runs,
  };
}
