// SPDX-License-Identifier: Apache-2.0

/** Which spaces admit each list spanning spaces, and the « Vue d'ensemble » mode's rules. */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage();

const {
  grantedInSomeSpace,
  holdsOverview,
  listAdmits,
  overviewLapsed,
  overviewListVerdict,
  overviewOffered,
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
        space("spc_blind", ["chat:read"]),
      ]),
    ).toBe(false);
    expect(overviewOffered(undefined)).toBe(false);
  });
});

describe("overviewLapsed", () => {
  it("lapses once the listing proves the mode no longer offered, not before it answers", () => {
    expect(overviewLapsed([space("spc_a", ["runs:read"])])).toBe(true);
    expect(overviewLapsed(TWO)).toBe(false);
    expect(overviewLapsed(undefined)).toBe(false);
  });
});

describe("listAdmits", () => {
  it("admits a list where the permissions of its route hold", () => {
    expect(listAdmits("runs")(["runs:read-all"])).toBe(true);
    // An agent is seen by a runner too (`packageSightPermissions("agent")`).
    expect(listAdmits("agents")(["agents:run"])).toBe(true);
    expect(listAdmits("skills")(["skills:read"])).toBe(true);
    expect(listAdmits("integrations")(["integrations:read"])).toBe(true);
    expect(listAdmits("mcp-servers")(["mcp-servers:read"])).toBe(true);
    expect(listAdmits("skills")(["agents:read", "integrations:read"])).toBe(false);
  });
});

describe("grantedInSomeSpace", () => {
  it("asks every space with a role, none without one", () => {
    expect(grantedInSomeSpace(TWO, "files:read")).toBe(true);
    expect(grantedInSomeSpace(TWO, "schedules:read")).toBe(false);
    expect(grantedInSomeSpace([space("spc_c", ["schedules:read"], "none")], "schedules:read")).toBe(
      false,
    );
  });
});

describe("holdsOverview", () => {
  it("holds on the lists and their rows, the dashboard, the routes of no space, an undeclared address", () => {
    for (const path of [
      "/",
      "/runs",
      "/schedules",
      "/schedules/:id",
      "/files",
      "/files/:fileId",
      "/agents",
      "/agents/:scope/:name",
      "/agents/:scope/:name/:version",
      "/agents/:scope/:name/runs/:runId",
      "/skills",
      "/skills/:scope/:name",
      "/skills/:scope/:name/:version",
      "/integrations",
      "/integrations/:scope/:name",
      "/mcp-servers",
      "/mcp-servers/:scope/:name",
      "/mcp-servers/:scope/:name/:version",
      "/org-settings",
      "/org-settings/members",
      "/org-settings/billing",
      "/preferences/general",
    ] as const) {
      expect({ path, holds: holdsOverview(path) }).toEqual({ path, holds: true });
    }
    expect(holdsOverview(undefined)).toBe(true);
  });

  it("is left by any route of one space: the catalogue (it acts « here »), the chat, a creation, the workspace settings", () => {
    for (const path of [
      "/catalogue",
      "/catalogue/:type",
      "/integrations/new/mcp",
      "/chat",
      "/chat/:conversationId",
      "/workspace-settings",
      "/workspace-settings/general",
      "/workspace-settings/webhooks",
    ] as const) {
      expect({ path, holds: holdsOverview(path) }).toEqual({ path, holds: false });
    }
  });
});

describe("overviewListVerdict", () => {
  it("opens a list where some space admits it, and says nothing of other routes", () => {
    expect(overviewListVerdict("/files", TWO)).toBe("granted");
    expect(overviewListVerdict("/schedules", TWO)).toBe("denied");
    expect(overviewListVerdict("/agents", TWO)).toBe("denied");
    expect(overviewListVerdict("/agents", [...TWO, space("spc_c", ["agents:run"])])).toBe(
      "granted",
    );
    expect(overviewListVerdict("/", TWO)).toBeUndefined();
    expect(overviewListVerdict("/agents/:scope/:name", TWO)).toBeUndefined();
  });
});
