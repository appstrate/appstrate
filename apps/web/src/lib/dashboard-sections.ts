// SPDX-License-Identifier: Apache-2.0

import {
  canReadRuns,
  packageSightPermissions,
  type CorePermission,
} from "@appstrate/core/permissions";

interface DashboardSections {
  schedules: boolean;
  recentAgents: boolean;
  recentRuns: boolean;
}

/** The dashboard renders for ANY principal, so each section answers to the guard of its own query. Pure: an API test imports it. */
export function dashboardSections(can: (permission: CorePermission) => boolean): DashboardSections {
  const runs = canReadRuns(can);
  return {
    schedules: can("schedules:read"),
    // Picked out of the recent runs, then named from the agent index.
    recentAgents: runs && packageSightPermissions("agent").some(can),
    recentRuns: runs,
  };
}
