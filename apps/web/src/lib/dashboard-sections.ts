// SPDX-License-Identifier: Apache-2.0

import { canReadRuns } from "@appstrate/core/permissions";
import type { GateablePermission } from "../hooks/use-permissions";
import { packageSightPermissions } from "./package-permissions";

/** Which dashboard sections the caller can read — each one is its own read. */
export interface DashboardSections {
  schedules: boolean;
  recentAgents: boolean;
  recentRuns: boolean;
}

/**
 * The dashboard is the fallback route: it renders for ANY principal, so each
 * section answers to the guard of the query that feeds it (#1556). The same
 * disjunctions gate the hooks themselves; this decides what is drawn.
 */
export function dashboardSections(
  can: (permission: GateablePermission) => boolean,
): DashboardSections {
  const runs = canReadRuns(can);
  return {
    schedules: can("schedules:read"),
    // Picked out of the recent runs, then named from the agent index.
    recentAgents: runs && packageSightPermissions("agent").some(can),
    recentRuns: runs,
  };
}

export function hasAnyDashboardSection(sections: DashboardSections): boolean {
  return sections.schedules || sections.recentAgents || sections.recentRuns;
}
