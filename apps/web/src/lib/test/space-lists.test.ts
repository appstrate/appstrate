// SPDX-License-Identifier: Apache-2.0

/** Which spaces admit each list spanning spaces, and the « Vue d'ensemble » mode's rules. */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage();

const {
  holdsOverview,
  overviewEntry,
  overviewLanding,
  overviewListVerdict,
  overviewModeOn,
  overviewOffered,
  shownInOverview,
} = await import("../space-lists.ts");

const space = (id: string, permissions: string[], access = "member") => ({
  id,
  access,
  permissions,
});
const TWO = [space("spc_a", ["runs:read"]), space("spc_b", ["files:read"])];

describe("overviewOffered", () => {
  it("is offered from two spaces admitting at least one list, not necessarily the same", () => {
    expect(overviewOffered(TWO)).toBe(true);
  });

  it("is not offered from one such space, nor counting a space without a role or a list", () => {
    expect(overviewOffered([space("spc_a", ["runs:read"])])).toBe(false);
    expect(
      overviewOffered([
        space("spc_a", ["runs:read"]),
        space("spc_closed", ["runs:read"], "none"),
        space("spc_blind", ["agents:read"]),
      ]),
    ).toBe(false);
    expect(overviewOffered(undefined)).toBe(false);
  });
});

describe("overviewModeOn", () => {
  it("is on only while chosen AND offered", () => {
    expect(overviewModeOn(true, TWO)).toBe(true);
    expect(overviewModeOn(false, TWO)).toBe(false);
    // A reader who falls below two spaces: off, whatever was chosen.
    expect(overviewModeOn(true, [space("spc_a", ["runs:read"])])).toBe(false);
  });
});

describe("holdsOverview", () => {
  it("holds on the lists and their details, the home, the routes of no space, an undeclared address", () => {
    for (const path of [
      "/runs",
      "/schedules",
      "/files",
      "/agents/:scope/:name/runs/:runId",
      "/schedules/:id",
      "/",
      "/files/:fileId",
      "/org-settings",
      "/org-settings/members",
      "/org-settings/billing",
      "/preferences/general",
    ] as const) {
      expect({ path, holds: holdsOverview(path) }).toEqual({ path, holds: true });
    }
    expect(holdsOverview(undefined)).toBe(true);
  });

  it("is left by any route of one space, the catalogue included (it acts « here »)", () => {
    for (const path of [
      "/agents",
      "/agents/:scope/:name",
      "/catalogue",
      "/catalogue/:type",
      "/skills",
      "/integrations",
      "/mcp-servers",
      "/chat",
      "/workspace-settings",
      "/workspace-settings/general",
      "/workspace-settings/webhooks",
    ] as const) {
      expect({ path, holds: holdsOverview(path) }).toEqual({ path, holds: false });
    }
  });
});

describe("shownInOverview", () => {
  it("links the lists and the routes of no space, never the home", () => {
    expect(
      ["/runs", "/schedules", "/files", "/files/:fileId", "/org-settings"].every((p) =>
        shownInOverview(p as "/runs"),
      ),
    ).toBe(true);
    expect(shownInOverview("/")).toBe(false);
    expect(shownInOverview("/agents")).toBe(false);
    expect(shownInOverview("/chat")).toBe(false);
    expect(shownInOverview("/catalogue")).toBe(false);
  });
});

describe("overviewLanding and overviewEntry", () => {
  it("lands on the first list a space admits", () => {
    expect(
      overviewLanding([space("spc_a", ["schedules:read"]), space("spc_b", ["files:read"])]),
    ).toBe("/schedules");
    expect(overviewLanding(TWO)).toBe("/runs");
  });

  it("stays on a page that holds the mode, and leaves the others for the first list", () => {
    expect(overviewEntry(TWO, "/files")).toBeNull();
    expect(overviewEntry(TWO, "/org-settings/members")).toBeNull();
    // A row's detail opened in the mode keeps it.
    expect(overviewEntry(TWO, "/schedules/:id")).toBeNull();
    expect(overviewEntry(TWO, "/agents")).toBe("/runs");
    expect(overviewEntry(TWO, "/")).toBe("/runs");
  });
});

describe("overviewListVerdict", () => {
  it("opens a list where some space admits it, and says nothing of other routes", () => {
    expect(overviewListVerdict("/files", TWO)).toBe("granted");
    expect(overviewListVerdict("/schedules", TWO)).toBe("denied");
    expect(overviewListVerdict("/agents", TWO)).toBeUndefined();
  });
});
