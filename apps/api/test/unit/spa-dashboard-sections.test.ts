// SPDX-License-Identifier: Apache-2.0

/**
 * The dashboard is the fallback route every principal lands on (#1556): each
 * section is drawn only when the read behind it is open. Pinned against the
 * presets' real grants, which live on this side of the tree.
 */

import { describe, it, expect } from "bun:test";
import { SPACE_ROLE_PRESETS, type CorePermission } from "@appstrate/core/permissions";
import { presetPermissions } from "../../src/lib/permissions.ts";
import { dashboardSections } from "../../../web/src/lib/dashboard-sections.ts";

const holding = (granted: Iterable<string>) => {
  const set = new Set<string>(granted);
  return (permission: CorePermission) => set.has(permission);
};

describe("dashboardSections", () => {
  it("draws each preset the sections its grants open", () => {
    const verdicts = Object.fromEntries(
      SPACE_ROLE_PRESETS.map((preset) => [
        preset,
        dashboardSections(holding(presetPermissions(preset))),
      ]),
    );
    const all = { schedules: true, recentAgents: true, recentRuns: true };
    expect(verdicts).toEqual({
      admin: all,
      builder: all,
      operator: all,
      runner: { schedules: false, recentAgents: true, recentRuns: true },
      viewer: all,
    });
  });

  it("shows nothing to an empty role", () => {
    expect(dashboardSections(holding([]))).toEqual({
      schedules: false,
      recentAgents: false,
      recentRuns: false,
    });
  });

  it("opens the runs on `runs:read-all` alone", () => {
    expect(dashboardSections(holding(["runs:read-all"])).recentRuns).toBe(true);
  });

  // Recent agents are picked out of the recent runs: the index alone ranks nothing.
  it("keeps recent agents behind the runs read", () => {
    const sections = dashboardSections(holding(["agents:read", "schedules:read"]));
    expect(sections).toEqual({ schedules: true, recentAgents: false, recentRuns: false });
  });
});
