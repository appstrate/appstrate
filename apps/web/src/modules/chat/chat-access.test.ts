// SPDX-License-Identifier: Apache-2.0

/**
 * The chat capability table, against the one property that matters: a row is
 * TRUE only when the route behind it would accept.
 *
 * A chip that over-claims is worse than no chip — the user is told the
 * assistant can do something, asks for it, and gets a refusal they now have no
 * way to explain. So every case below is a way of over-claiming, and
 * `activateIntegrations` gets the most attention because it is the one row
 * whose answer is NOT "does the caller hold a permission".
 */

import { describe, expect, it } from "bun:test";
import {
  accessStanding,
  limitedGrants,
  resolveChatCapabilities,
  type ChatAccessContext,
} from "./chat-access.ts";
import { spacePackagePermission } from "@appstrate/core/permissions";
import type { SpaceGrant } from "../../lib/package-permissions.ts";

/** The grant `maySetPackageActive` reads for an integration in a team space. */
const INTEGRATION_ACTIVATE_PERMISSION = spacePackagePermission("integration", "activate");

/**
 * A caller holding exactly `permissions` in the one space the chat acts in, shaped by `space`
 * (`null`: it acts in none), agent authoring on unless said.
 */
function context(
  permissions: string[],
  space: Partial<SpaceGrant> | null = {},
  authoring = true,
): ChatAccessContext {
  return {
    spaces:
      space === null
        ? []
        : [{ id: "spc_1", permissions, personal: false, access: "member", ...space }],
    authoring,
  };
}

/** Every row id, in declaration order. */
const ROW_IDS = resolveChatCapabilities(context([])).map((c) => c.id);

/** Whether each row is granted: with authoring on, a row is either granted or denied. */
function verdicts(ctx: ChatAccessContext): Record<string, boolean> {
  return Object.fromEntries(
    resolveChatCapabilities(ctx).map((c) => [c.id, c.verdict === "granted"]),
  );
}

/**
 * What any acting row needs before its own permission: the turn itself
 * (`chat:write`), the MCP endpoint (`mcp:read`) and the dispatching tools
 * (`mcp:invoke`).
 */
const CONVERSES = ["chat:write", "mcp:read", "mcp:invoke"];

/** Every permission any row reads — a caller who holds the lot. */
const PACKAGE_WRITES = ["agents:write", "skills:write", "integrations:write"];

const EVERYTHING = [
  ...CONVERSES,
  "agents:run",
  "agents:write",
  "skills:write",
  "integrations:write",
  "runs:read",
  "runs:read-all",
  "files:read",
  "integrations:connect",
  INTEGRATION_ACTIVATE_PERMISSION,
  "schedules:write",
];

describe("the capability table", () => {
  it("has unique ids and unique label keys", () => {
    // A duplicated label key is the copy-paste bug this table invites: two rows
    // render the same sentence and one capability silently stops being shown.
    const labels = resolveChatCapabilities(context([])).map((c) => c.labelKey);
    expect(new Set(ROW_IDS).size).toBe(ROW_IDS.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("spells every label key in full, so the locale guard can see it", () => {
    // The reverse locale guard resolves string literals. A key built from `id`
    // would be invisible to it and could rot into an untranslated raw key.
    for (const capability of resolveChatCapabilities(context([]))) {
      expect(capability.labelKey.startsWith("access.capability.")).toBe(true);
    }
  });

  it("grants nothing to a caller holding nothing", () => {
    expect(Object.values(verdicts(context([])))).toEqual(ROW_IDS.map(() => false));
  });

  it("grants nothing while no space the chat acts in is known", () => {
    // An empty `spaces` is "not loaded" (or acting nowhere): it reads as no, never as yes.
    expect(Object.values(verdicts(context(EVERYTHING, null)))).toEqual(ROW_IDS.map(() => false));
  });

  it("grants everything to a caller holding every underlying permission", () => {
    expect(Object.values(verdicts(context(EVERYTHING, {})))).toEqual(ROW_IDS.map(() => true));
  });
});

describe("each row's own permission", () => {
  // A row keyed on `invokes` alone — its own permission dropped — would still
  // pass every "holds everything" case. Each case below removes ONLY what one
  // row reads beyond the shared prerequisites, from a caller holding
  // everything, and pins exactly which rows fall: that row, plus the rows that
  // are defined as requiring it too, and no other.
  const cases: { row: string; removes: string[]; refuses: string[] }[] = [
    {
      row: "callApi",
      removes: ["mcp:invoke"],
      // Every act dispatches through `mcp:invoke`; browsing does not.
      refuses: ROW_IDS.filter((id) => id !== "browseFiles"),
    },
    // `run_and_wait` also needs a run-read permission, so both fall together.
    {
      row: "readRuns",
      removes: ["runs:read", "runs:read-all"],
      refuses: ["runAgents", "readRuns"],
    },
    { row: "runAgents", removes: ["agents:run"], refuses: ["runAgents"] },
    {
      row: "createPackages",
      removes: PACKAGE_WRITES,
      refuses: ["createPackages"],
    },
    { row: "browseFiles", removes: ["files:read"], refuses: ["browseFiles"] },
    {
      row: "connectIntegrations",
      removes: ["integrations:connect"],
      refuses: ["connectIntegrations"],
    },
    // `{}` below is a TEAM space, where activation is the bare grant.
    {
      row: "activateIntegrations",
      removes: [INTEGRATION_ACTIVATE_PERMISSION],
      refuses: ["activateIntegrations"],
    },
    { row: "schedule", removes: ["schedules:write"], refuses: ["schedule"] },
  ];

  it("covers every row of the table", () => {
    expect(cases.map((c) => c.row).sort()).toEqual([...ROW_IDS].sort());
  });

  it.each(cases)("refuses $row once only its own permission is gone", ({ removes, refuses }) => {
    const without = verdicts(
      context(
        EVERYTHING.filter((p) => !removes.includes(p)),
        {},
      ),
    );
    expect(without).toEqual(Object.fromEntries(ROW_IDS.map((id) => [id, !refuses.includes(id)])));
  });
});

describe("the package-authoring switch", () => {
  function verdictOf(ctx: ChatAccessContext, id: string) {
    return resolveChatCapabilities(ctx).find((c) => c.id === id)?.verdict;
  }

  it("turns off a held `createPackages` row, and only while it is off", () => {
    expect(verdictOf(context(EVERYTHING, {}, false), "createPackages")).toBe("off");
    expect(verdictOf(context(EVERYTHING, {}, true), "createPackages")).toBe("granted");
  });

  it("leaves a row the caller does not hold denied, not off", () => {
    const without = EVERYTHING.filter((p) => !PACKAGE_WRITES.includes(p));
    expect(verdictOf(context(without, {}, false), "createPackages")).toBe("denied");
  });

  it("never turns off another row", () => {
    const others = resolveChatCapabilities(context(EVERYTHING, {}, false)).filter(
      (c) => c.id !== "createPackages",
    );
    expect(others.length).toBe(ROW_IDS.length - 1);
    for (const c of others) expect(c.verdict).toBe("granted");
  });
});

describe("seeing runs", () => {
  it("is granted by either run-read permission", () => {
    // `read-all` is the WIDER of the two and implies `read` (RBAC spec §3.4).
    // A row asking only for `read` would tell a space supervisor it cannot see
    // runs, which is the opposite of true.
    expect(verdicts(context([...CONVERSES, "runs:read"])).readRuns).toBe(true);
    expect(verdicts(context([...CONVERSES, "runs:read-all"])).readRuns).toBe(true);
    expect(verdicts(context(CONVERSES)).readRuns).toBe(false);
  });
});

describe("running an agent", () => {
  it("is refused to a caller who may launch but not read runs", () => {
    // `run_and_wait` refuses before launching without `runs:read` or
    // `runs:read-all` (it could not poll the run it started). Keyed on
    // `agents:run` alone, the row would promise exactly that refusal.
    const launcher = verdicts(context([...CONVERSES, "agents:run"]));
    expect(launcher.runAgents).toBe(false);
    expect(verdicts(context([...CONVERSES, "agents:run", "runs:read"])).runAgents).toBe(true);
    expect(verdicts(context([...CONVERSES, "agents:run", "runs:read-all"])).runAgents).toBe(true);
  });

  // The row-vs-permissions agreement over every subset is pinned once, on the
  // shared derivation itself (`packages/module-chat/test/capabilities.test.ts`).
});

describe("creating an agent", () => {
  it("is denied without `mcp:invoke`, which `createAgent` dispatches through", () => {
    // `agents:write` is not enough on its own: the assistant creates an agent by
    // calling `invoke_operation`, so a turn without it holds a grant it can
    // never use — and the server persona drops the authoring half for the same
    // reason. A row keyed on `agents:write` alone would show a granted chip
    // whose act is unreachable, and hide the composer's toggle behind it.
    expect(verdicts(context(["chat:write", "mcp:read", "agents:write"])).createPackages).toBe(
      false,
    );
    // Control: the same set plus the dispatching tool holds the row.
    expect(
      verdicts(context(["chat:write", "mcp:read", "mcp:invoke", "agents:write"])).createPackages,
    ).toBe(true);
  });
});

describe("browsing files", () => {
  it("needs the MCP endpoint and `files:read`, not `mcp:invoke`", () => {
    // `list_files` is not an `invoke_operation` call: the endpoint's
    // `mcp:read` gate and the `GET /api/files` guard are the whole of it.
    expect(verdicts(context(["chat:write", "mcp:read", "files:read"])).browseFiles).toBe(true);
    expect(verdicts(context(["chat:write", "files:read"])).browseFiles).toBe(false);
  });
});

describe("activating an integration", () => {
  it("is granted in a TEAM space only with the activation grant", () => {
    expect(
      verdicts(context([...CONVERSES, INTEGRATION_ACTIVATE_PERMISSION], { personal: false }))
        .activateIntegrations,
    ).toBe(true);
    expect(verdicts(context(CONVERSES, { personal: false })).activateIntegrations).toBe(false);
  });

  it("is granted when ONE of the spaces the chat acts in allows it", () => {
    const refused = {
      id: "spc_r",
      permissions: CONVERSES,
      personal: false,
      access: "member" as const,
    };
    const allowed = {
      ...refused,
      id: "spc_a",
      permissions: [...CONVERSES, INTEGRATION_ACTIVATE_PERMISSION],
    };
    const ctx = { authoring: true };
    expect(verdicts({ ...ctx, spaces: [refused] }).activateIntegrations).toBe(false);
    expect(verdicts({ ...ctx, spaces: [refused, allowed] }).activateIntegrations).toBe(true);
  });

  it("is granted in the caller's PERSONAL space WITHOUT that permission", () => {
    // RBAC spec §3.6: ownership is the authorization there, so the route skips
    // the activation grant. It matters for a GUEST, who holds `operator` in
    // their own space (`space-role.ts`) — no activation grant — and is
    // accepted anyway. A row keyed on the bare permission would claim a
    // refusal that never happens.
    expect(
      verdicts(context(CONVERSES, { personal: true, access: "member" })).activateIntegrations,
    ).toBe(true);
  });

  it("is NOT granted by a personal space the caller cannot enter", () => {
    // `personal && access === "member"` is what stands in for "this one is
    // mine" — the owner's id is deliberately absent from the wire. Dropping
    // the second half would hand every personal space to every caller.
    expect(
      verdicts(context(CONVERSES, { personal: true, access: "none" })).activateIntegrations,
    ).toBe(false);
  });

  it("is NOT granted by ownership alone when the assistant cannot invoke", () => {
    // The ownership exemption is the ROUTE's; the assistant still has to
    // reach the route, and `invoke_operation` refuses without `mcp:invoke`.
    expect(
      verdicts(context(["chat:write", "mcp:read"], { personal: true, access: "member" }))
        .activateIntegrations,
    ).toBe(false);
  });

  it("is distinct from connecting an account", () => {
    // The distinction the chat's own system prompt has to explain when an
    // `integration_not_active` error lands: connecting is personal, activating
    // is per space. Holding one must never light up the other.
    const team = { personal: false };
    const connector = verdicts(context([...CONVERSES, "integrations:connect"], team));
    expect(connector.connectIntegrations).toBe(true);
    expect(connector.activateIntegrations).toBe(false);
  });
});

describe("reaching the API at all", () => {
  it("gates every act on `mcp:invoke`, whatever package permission is held", () => {
    // Every act goes through `invoke_operation` or `run_and_wait`, and both
    // refuse without `mcp:invoke` before dispatching. A caller holding the
    // package permissions but not it gets nothing but browsing — which is
    // not an `invoke_operation` call.
    const noInvoke = verdicts(
      context(
        EVERYTHING.filter((p) => p !== "mcp:invoke"),
        {},
      ),
    );
    expect(noInvoke).toEqual({
      ...Object.fromEntries(ROW_IDS.map((id) => [id, false])),
      browseFiles: true,
    });
  });

  it("gates everything on the MCP endpoint's own `mcp:read`", () => {
    const noEndpoint = verdicts(
      context(
        EVERYTHING.filter((p) => p !== "mcp:read"),
        {},
      ),
    );
    expect(Object.values(noEndpoint)).toEqual(ROW_IDS.map(() => false));
  });
});

describe("a caller who may read the chat but not write to it", () => {
  it("is shown no capability at all, whatever else they hold", () => {
    // The `viewer` preset: `chat:read` and `mcp:read`, no `chat:write`. The
    // turn itself (`POST /api/orgs/:orgId/chat`) needs `chat:write`, so the assistant
    // never gets the message that would make it act.
    const viewer = verdicts(
      context(["chat:read", "mcp:read", "runs:read", "files:read", "agents:read"], {}),
    );
    expect(Object.values(viewer)).toEqual(ROW_IDS.map(() => false));

    const readOnlyEverything = verdicts(
      context(
        EVERYTHING.filter((p) => p !== "chat:write"),
        {},
      ),
    );
    expect(Object.values(readOnlyEverything)).toEqual(ROW_IDS.map(() => false));
  });
});

describe("the spaces granting each row", () => {
  const team = (id: string, permissions: string[]) => ({
    id,
    permissions: ["mcp:read", "mcp:invoke", ...permissions],
    personal: false,
    access: "member" as const,
  });
  const spacesOf = (ctx: ChatAccessContext) =>
    Object.fromEntries(resolveChatCapabilities(ctx).map((c) => [c.id, c.spaceIds]));

  it("names, for each row, the acting spaces that grant it, in order", () => {
    const ctx: ChatAccessContext = {
      spaces: [
        team("spc_a", ["chat:write", "runs:read", "files:read"]),
        team("spc_b", ["chat:write", "files:read", "schedules:write"]),
      ],
      authoring: true,
    };
    const spaces = spacesOf(ctx);
    expect(spaces.readRuns).toEqual(["spc_a"]);
    expect(spaces.browseFiles).toEqual(["spc_a", "spc_b"]);
    expect(spaces.schedule).toEqual(["spc_b"]);
    expect(spaces.runAgents).toEqual([]);
    // The verdict is the same computation: granted exactly where a space is named.
    for (const c of resolveChatCapabilities(ctx)) {
      expect({ id: c.id, granted: c.verdict === "granted" }).toEqual({
        id: c.id,
        granted: c.spaceIds.length > 0,
      });
    }
  });

  it("judges each space alone: grants split across two spaces hold no row", () => {
    // `run_and_wait` launches and polls in ONE space: launching in one and reading in another
    // is no run the assistant can follow.
    const ctx: ChatAccessContext = {
      spaces: [
        team("spc_a", ["chat:write", "agents:run"]),
        team("spc_b", ["chat:write", "runs:read"]),
      ],
      authoring: true,
    };
    expect(spacesOf(ctx).runAgents).toEqual([]);
    expect(spacesOf(ctx).readRuns).toEqual(["spc_b"]);
  });

  it("names nothing for a space where the caller may not write to the chat", () => {
    const ctx: ChatAccessContext = {
      spaces: [team("spc_a", ["chat:write", "files:read"]), team("spc_b", ["files:read"])],
      authoring: true,
    };
    expect(spacesOf(ctx).browseFiles).toEqual(["spc_a"]);
  });
});

describe("the standing the access summary names", () => {
  const origin = { name: "Atelier", role: "Opérateur" };

  it("names the selected space's role, the org role standing in for none", () => {
    for (const conversationOrigin of [origin, null]) {
      expect(
        accessStanding({
          overview: false,
          orgRole: "Membre",
          workingRole: "Lecteur",
          origin: conversationOrigin,
        }),
      ).toEqual({
        headline: "Lecteur",
        line: { key: "access.roleLine", params: { org: "Membre", space: "Lecteur" } },
      });
    }
    expect(
      accessStanding({ overview: false, orgRole: "Membre", workingRole: null, origin: null }),
    ).toEqual({
      headline: "Membre",
      line: { key: "access.roleLine", params: { org: "Membre", space: "—" } },
    });
  });

  it("never names the hidden working space in « Tous les espaces »", () => {
    const standing = accessStanding({
      overview: true,
      orgRole: "Membre",
      workingRole: "Lecteur",
      origin: null,
    });
    expect(standing).toEqual({
      headline: "Membre",
      line: { key: "access.roleLineOrg", params: { org: "Membre" } },
    });
  });

  it("names the conversation's origin space by name, with the role held there", () => {
    expect(
      accessStanding({ overview: true, orgRole: "Membre", workingRole: "Lecteur", origin }),
    ).toEqual({
      headline: "Membre",
      line: {
        key: "access.roleLineIn",
        params: { org: "Membre", name: "Atelier", space: "Opérateur" },
      },
    });
  });
});

describe("a limited conversation", () => {
  it("keeps only the origin and drops the organization-only writes from its effective grants", () => {
    const origin = {
      id: "spc_a",
      access: "member" as const,
      personal: false,
      permissions: [
        "chat:read",
        "chat:write",
        "mcp:read",
        "files:read",
        "org:settings",
        "members:read",
      ],
    };
    const other = { ...origin, id: "spc_b", permissions: [...origin.permissions, "agents:write"] };
    const org = ["org:settings", "members:read"];
    expect(limitedGrants([origin, other], origin.id, org)).toEqual([
      {
        ...origin,
        permissions: ["chat:read", "chat:write", "mcp:read", "files:read", "members:read"],
      },
    ]);
    expect(limitedGrants([other], origin.id, org)).toEqual([]);
  });
});
