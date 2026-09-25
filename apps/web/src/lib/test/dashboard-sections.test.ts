// SPDX-License-Identifier: Apache-2.0

/**
 * The dashboard is the fallback route every principal lands on (#1556): each
 * section is drawn only when the read behind it is open, and a role holding
 * none of them gets the empty state rather than a page of refused requests.
 * The sets below are the space-role presets' relevant grants
 * (`apps/api/src/lib/permissions.ts`), written out.
 */

import { describe, it, expect } from "bun:test";
import { dashboardSections } from "../dashboard-sections.ts";

const can = (granted: string[]) => (permission: string) => granted.includes(permission);

describe("dashboardSections", () => {
  it("shows nothing to an empty role", () => {
    expect(dashboardSections(can([]))).toEqual({
      schedules: false,
      recentAgents: false,
      recentRuns: false,
    });
  });

  it("shows a runner its agents and runs, but no schedules", () => {
    expect(dashboardSections(can(["agents:run", "runs:read", "files:read"]))).toEqual({
      schedules: false,
      recentAgents: true,
      recentRuns: true,
    });
  });

  it("shows a viewer every section", () => {
    expect(
      dashboardSections(can(["agents:read", "runs:read", "schedules:read", "files:read"])),
    ).toEqual({ schedules: true, recentAgents: true, recentRuns: true });
  });

  it("opens the runs on `runs:read-all` alone", () => {
    expect(dashboardSections(can(["runs:read-all"])).recentRuns).toBe(true);
  });

  // Recent agents are picked out of the recent runs: the agent index alone
  // has nothing to rank them by.
  it("keeps recent agents behind the runs read", () => {
    const sections = dashboardSections(can(["agents:read", "schedules:read"]));
    expect(sections.recentAgents).toBe(false);
    expect(sections.schedules).toBe(true);
  });
});
