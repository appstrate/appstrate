// SPDX-License-Identifier: Apache-2.0

/**
 * The dashboard is the fallback route every principal lands on (#1556): each
 * section is drawn only when the read behind it is open, and a role holding
 * none of them gets the empty state rather than a page of refused requests.
 * The sets below are the space-role presets' relevant grants
 * (`apps/api/src/lib/permissions.ts`), written out.
 */

import { describe, it, expect } from "bun:test";
import { dashboardSections, hasAnyDashboardSection } from "../dashboard-sections.ts";
import { packageReadPermission, packageSightPermissions } from "../package-permissions.ts";

const can = (granted: string[]) => (permission: string) => granted.includes(permission);

describe("dashboardSections", () => {
  it("shows nothing to an empty role", () => {
    const sections = dashboardSections(can([]));
    expect(sections).toEqual({ schedules: false, recentAgents: false, recentRuns: false });
    expect(hasAnyDashboardSection(sections)).toBe(false);
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
    expect(hasAnyDashboardSection(sections)).toBe(true);
  });
});

describe("package read permissions", () => {
  it("lets `agents:run` see an agent, and nothing else of a package family", () => {
    expect(packageSightPermissions("agent")).toEqual(["agents:read", "agents:run"]);
    expect(packageSightPermissions("skill")).toEqual(["skills:read"]);
    expect(packageReadPermission("agent")).toBe("agents:read");
    expect(packageReadPermission("mcp-server")).toBe("mcp-servers:read");
  });
});
