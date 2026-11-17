// SPDX-License-Identifier: Apache-2.0

/** Which spaces admit each list spanning spaces, and the « Tous les espaces » mode's rules. */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage();

const {
  holdsOverview,
  isListRow,
  isSpaceEnterable,
  listAdmits,
  overviewListVerdict,
  overviewOffered,
  spaceChoice,
  spacesWhere,
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

describe("isSpaceEnterable", () => {
  it("enters on member access only", () => {
    expect(isSpaceEnterable({ access: "member" })).toBe(true);
    // A closed space the caller may ask to join, an orphaned personal space.
    expect(isSpaceEnterable({ access: "none" })).toBe(false);
  });
});

describe("listAdmits", () => {
  const gate =
    (...held: string[]) =>
    (permission: string) =>
      held.includes(permission);

  it("admits a list where the permissions of its route hold", () => {
    expect(listAdmits("runs")(gate("runs:read-all"))).toBe(true);
    // An agent is seen by a runner too (`packageSightPermissions("agent")`).
    expect(listAdmits("agents")(gate("agents:run"))).toBe(true);
    expect(listAdmits("skills")(gate("skills:read"))).toBe(true);
    expect(listAdmits("integrations")(gate("integrations:read"))).toBe(true);
    expect(listAdmits("skills")(gate("agents:read", "integrations:read"))).toBe(false);
  });

  it("judges each space by its own set, through spacesWhere", () => {
    expect(spacesWhere(TWO, undefined, listAdmits("files")).map((s) => s.id)).toEqual(["spc_b"]);
    expect(spacesWhere(TWO, undefined, listAdmits("schedules"))).toEqual([]);
    expect(
      spacesWhere([space("spc_c", ["schedules:read"], "none")], undefined, listAdmits("schedules")),
    ).toEqual([]);
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
      "/org-settings",
      "/org-settings/members",
      "/org-settings/billing",
      "/preferences/general",
      // It names no space: its add menu and « Par espace » name each deed's.
      "/catalogue",
      "/catalogue/:type",
    ] as const) {
      expect({ path, holds: holdsOverview(path) }).toEqual({ path, holds: true });
    }
    expect(holdsOverview(undefined)).toBe(true);
  });

  it("is left by any route of one space: the chat, a creation, the workspace settings", () => {
    for (const path of [
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

describe("isListRow", () => {
  it("is a row of a list spanning spaces, never the list, a creation or a page of no space", () => {
    for (const path of [
      "/runs",
      "/agents",
      "/integrations/new/mcp",
      "/notifications/:id",
      "/",
      "/catalogue/:type",
    ] as const) {
      expect({ path, row: isListRow(path) }).toEqual({ path, row: false });
    }
    for (const path of [
      "/agents/:scope/:name",
      "/agents/:scope/:name/runs/:runId",
      "/schedules/:id",
      "/files/:fileId",
      "/skills/:scope/:name/:version",
      "/integrations/:scope/:name",
    ] as const) {
      expect({ path, row: isListRow(path) }).toEqual({ path, row: true });
    }
    expect(isListRow(undefined)).toBe(false);
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

describe("spacesWhere", () => {
  const spaces = [
    space("spc_a", ["agents:write"]),
    space("spc_b", ["agents:read"]),
    space("spc_closed", ["agents:write"], "none"),
  ];
  const writes = (can: (permission: string) => boolean) => can("agents:write");

  it("keeps the spaces held with a role whose grants admit the action", () => {
    expect(spacesWhere(spaces, [], writes).map((s) => s.id)).toEqual(["spc_a"]);
  });

  it("counts the org-level grants in every space, as the working space's gate does", () => {
    expect(spacesWhere(spaces, ["agents:write"], writes).map((s) => s.id)).toEqual([
      "spc_a",
      "spc_b",
    ]);
  });

  it("holds nothing before the listing answers", () => {
    expect(spacesWhere(undefined, [], writes)).toEqual([]);
  });
});

describe("spaceChoice", () => {
  it("offers nothing without a space, takes the only one, lets the reader choose between several", () => {
    expect(spaceChoice([])).toEqual({ kind: "none" });
    expect(spaceChoice([space("spc_a", [])])).toEqual({ kind: "one", spaceId: "spc_a" });
    expect(spaceChoice(TWO)).toEqual({ kind: "ask" });
  });

  it("takes the preferred space without a choice when it is eligible, and only then", () => {
    expect(spaceChoice(TWO, "spc_b")).toEqual({ kind: "one", spaceId: "spc_b" });
    expect(spaceChoice(TWO, "spc_other")).toEqual({ kind: "ask" });
    expect(spaceChoice([], "spc_a")).toEqual({ kind: "none" });
  });
});
