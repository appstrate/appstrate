// SPDX-License-Identifier: Apache-2.0

/** Which spaces admit each list spanning spaces, and the « Tous les espaces » mode's rules. */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage();

const {
  actingSpaces,
  connectionRowConfigures,
  grantedInSomeActingSpace,
  grantedForRow,
  grantsInRowSpace,
  holdsOverview,
  isListRow,
  isSpaceEnterable,
  listAdmits,
  spanningRouteVerdict,
  overviewOffered,
  spaceChoice,
  spacesHeld,
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
  it("holds on the lists and their rows, the chat (it serves the organization there), the dashboard, the routes of no space, an undeclared address", () => {
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
      "/chat",
      "/chat/:conversationId",
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

  it("is left by any route of one space: a creation", () => {
    for (const path of ["/integrations/new/mcp"] as const) {
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

describe("spanningRouteVerdict", () => {
  it("opens a list where some space admits it in the overview, and says nothing of other routes", () => {
    expect(spanningRouteVerdict("/files", TWO, true)).toBe("granted");
    expect(spanningRouteVerdict("/schedules", TWO, true)).toBe("denied");
    expect(spanningRouteVerdict("/agents", TWO, true)).toBe("denied");
    expect(spanningRouteVerdict("/agents", [...TWO, space("spc_c", ["agents:run"])], true)).toBe(
      "granted",
    );
    expect(spanningRouteVerdict("/", TWO, true)).toBeUndefined();
    expect(spanningRouteVerdict("/integrations/new/mcp", TWO, true)).toBeUndefined();
  });

  it("opens a list's row where some space admits the row's own route, not the hidden space", () => {
    const spaces = [space("spc_a", ["runs:read"]), space("spc_b", ["schedules:read"])];
    expect(spanningRouteVerdict("/schedules/:id", spaces, true)).toBe("granted");
    expect(spanningRouteVerdict("/agents/:scope/:name/runs/:runId", spaces, true)).toBe("granted");
    expect(spanningRouteVerdict("/skills/:scope/:name", spaces, true)).toBe("denied");
    // A version reads the manifest: `agents:run` opens the agent, not its versions.
    const runner = [...spaces, space("spc_c", ["agents:run"])];
    expect(spanningRouteVerdict("/agents/:scope/:name", runner, true)).toBe("granted");
    expect(spanningRouteVerdict("/agents/:scope/:name/:version", runner, true)).toBe("denied");
    // An `open` row is its own declaration's.
    expect(spanningRouteVerdict("/files/:fileId", spaces, true)).toBeUndefined();
  });

  it("leaves a row to the working space outside the overview", () => {
    expect(spanningRouteVerdict("/schedules/:id", TWO, false)).toBeUndefined();
  });

  it("leaves a list to the working space outside the overview", () => {
    expect(spanningRouteVerdict("/files", TWO, false)).toBeUndefined();
  });

  it("says nothing before the space listing has answered", () => {
    expect(spanningRouteVerdict("/chat", undefined, false)).toBeUndefined();
    expect(spanningRouteVerdict("/files", undefined, true)).toBeUndefined();
  });
});

describe("spanningRouteVerdict on the chat", () => {
  const spaces = [space("spc_a", ["runs:read"]), space("spc_b", ["chat:read"])];

  it("opens the chat where some space admits it, whatever the working space grants", () => {
    expect(spanningRouteVerdict("/chat", spaces, true)).toBe("granted");
    expect(spanningRouteVerdict("/chat/:conversationId", spaces, true)).toBe("granted");
  });

  it("opens it the same way outside the overview", () => {
    expect(spanningRouteVerdict("/chat", spaces, false)).toBe("granted");
    expect(spanningRouteVerdict("/chat/:conversationId", spaces, false)).toBe("granted");
  });

  it("refuses it where no space admits it, in every mode", () => {
    for (const overview of [true, false]) {
      expect(spanningRouteVerdict("/chat", TWO, overview)).toBe("denied");
      expect(
        spanningRouteVerdict("/chat", [space("spc_closed", ["chat:read"], "none")], overview),
      ).toBe("denied");
    }
  });
});

describe("grantedInSomeActingSpace", () => {
  const acting = ["chat:write", "chat:read", "mcp:read"];
  const spaces = [
    // The working space may read files but is no place the chat acts.
    space("spc_a", ["chat:read", "files:read"]),
    space("spc_b", [...acting, "skills:read"]),
  ];

  it("judges a permission in the spaces where the chat may act, not in the others", () => {
    expect(grantedInSomeActingSpace(spaces, [], "skills:read")).toBe(true);
    expect(grantedInSomeActingSpace(spaces, [], "files:read")).toBe(false);
    expect(grantedInSomeActingSpace(spaces, [], "chat:write")).toBe(true);
  });

  it("counts the org-level grants, and nothing before the listing answers", () => {
    expect(grantedInSomeActingSpace(spaces, ["files:read"], "files:read")).toBe(true);
    expect(grantedInSomeActingSpace(undefined, [], "chat:write")).toBe(false);
  });

  it("holds nothing where the acting set is incomplete", () => {
    expect(
      grantedInSomeActingSpace([space("spc_c", ["chat:write", "chat:read"])], [], "chat:read"),
    ).toBe(false);
  });
});

describe("actingSpaces", () => {
  const spaces = [
    space("spc_a", ["chat:read", "chat:write", "mcp:read"]),
    space("spc_viewer", ["chat:read", "mcp:read"]),
  ];

  it("keeps the spaces holding the whole acting triple", () => {
    expect(actingSpaces(spaces, []).map((s) => s.id)).toEqual(["spc_a"]);
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

describe("grantsInRowSpace", () => {
  const spaces = [
    space("spc_a", ["files:read"]),
    space("spc_b", ["agents:run"]),
    space("spc_closed", ["agents:run"], "none"),
  ];
  const working = (permission: string) => permission === "files:read";
  const grants = (rowSpaceId: string | undefined, orgPermissions: string[] = []) =>
    grantsInRowSpace(rowSpaceId, "spc_a", working, spaces, orgPermissions, "agents:run");

  it("judges a row of another space by that space's grants, not the working space's", () => {
    expect(grants("spc_b")).toBe(true);
  });

  it("judges a row of the working space, or of no space, by the working space's gate", () => {
    expect(grants("spc_a")).toBe(false);
    expect(grants(undefined)).toBe(false);
  });

  it("grants nothing in a space held without a role, or not listed", () => {
    expect(grants("spc_closed")).toBe(false);
    expect(grants("spc_gone")).toBe(false);
  });

  it("counts the org-level grants in the row's space", () => {
    expect(grantsInRowSpace("spc_b", "spc_a", working, spaces, ["x:y"], "x:y")).toBe(true);
  });
});

describe("grantedForRow", () => {
  const spaces = [
    space("spc_a", ["integrations:configure"]),
    space("spc_b", []),
    space("spc_closed", ["integrations:configure"], "none"),
  ];

  it("judges a row of one space in that space, never the working one", () => {
    expect(grantedForRow(spaces, [], "spc_a", "integrations:configure")).toBe(true);
    expect(grantedForRow(spaces, [], "spc_b", "integrations:configure")).toBe(false);
    // A space held with no role grants nothing.
    expect(grantedForRow(spaces, [], "spc_closed", "integrations:configure")).toBe(false);
  });

  it("judges an org-wide row in any space held with a role, org-level grants included", () => {
    expect(grantedForRow(spaces, [], null, "integrations:configure")).toBe(true);
    expect(grantedForRow([space("spc_b", [])], [], null, "integrations:configure")).toBe(false);
    expect(
      grantedForRow(
        [space("spc_b", [])],
        ["integrations:configure"],
        null,
        "integrations:configure",
      ),
    ).toBe(true);
    expect(grantedForRow(undefined, [], null, "integrations:configure")).toBe(false);
  });
});

const CONNECTION_SPACES = [
  space("spc_a", ["integrations:read"]),
  space("spc_b", ["integrations:read", "integrations:configure"]),
];
const connectionRow = (orgId: string, spaceId: string | null) => ({
  org: { id: orgId, name: "Acme" },
  space: spaceId ? { id: spaceId, name: spaceId } : null,
});

describe("connectionRowConfigures (Préférences › Connexions)", () => {
  it("follows the row's own space in the current organization", () => {
    expect(
      connectionRowConfigures(connectionRow("org_1", "spc_b"), "org_1", CONNECTION_SPACES, []),
    ).toBe(true);
    expect(
      connectionRowConfigures(connectionRow("org_1", "spc_a"), "org_1", CONNECTION_SPACES, []),
    ).toBe(false);
  });

  it("is any reached space's grant for an org-wide row", () => {
    expect(
      connectionRowConfigures(connectionRow("org_1", null), "org_1", CONNECTION_SPACES, []),
    ).toBe(true);
  });

  it("is refused for another organization's row, whatever the current one grants", () => {
    expect(
      connectionRowConfigures(connectionRow("org_2", "spc_b"), "org_1", CONNECTION_SPACES, []),
    ).toBe(false);
    expect(
      connectionRowConfigures(connectionRow("org_2", null), "org_1", CONNECTION_SPACES, []),
    ).toBe(false);
  });
});

describe("spacesHeld", () => {
  it("is every space held with a role, whatever it grants: what the bell lists and marks read", () => {
    const spaces = [
      space("spc_a", ["runs:read"]),
      space("spc_blind", []),
      space("spc_closed", ["runs:read"], "none"),
    ];
    expect(spacesHeld(spaces).map((s) => s.id)).toEqual(["spc_a", "spc_blind"]);
    expect(spacesHeld(undefined)).toEqual([]);
  });
});
