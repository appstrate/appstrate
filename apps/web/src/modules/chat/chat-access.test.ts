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
  CHAT_CAPABILITIES,
  resolveChatCapabilities,
  type ChatAccessContext,
} from "./chat-access.ts";
import { PACKAGE_PERMISSIONS, type SpaceGrant } from "../../lib/package-permissions.ts";

/** The grant `maySetPackageActive` reads for an integration in a team space. */
const INTEGRATION_ACTIVATE_PERMISSION = PACKAGE_PERMISSIONS.integration.activate;

/** A caller holding exactly `permissions`, standing in `space`. */
function context(permissions: string[], space?: Partial<SpaceGrant>): ChatAccessContext {
  const held = new Set(permissions);
  return {
    can: (permission) => held.has(permission),
    spaceGrant:
      space === undefined
        ? undefined
        : { permissions, personal: false, access: "member", ...space },
  };
}

function verdicts(ctx: ChatAccessContext): Record<string, boolean> {
  return Object.fromEntries(resolveChatCapabilities(ctx).map((c) => [c.id, c.granted]));
}

/**
 * What any acting row needs before its own permission: the turn itself
 * (`chat:write`), the MCP endpoint (`mcp:read`) and the dispatching tools
 * (`mcp:invoke`).
 */
const CONVERSES = ["chat:write", "mcp:read", "mcp:invoke"];

/** Every permission any row reads — a caller who holds the lot. */
const EVERYTHING = [
  ...CONVERSES,
  "agents:run",
  "agents:run-inline",
  "agents:write",
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
    const ids = CHAT_CAPABILITIES.map((c) => c.id);
    const labels = CHAT_CAPABILITIES.map((c) => c.labelKey);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("spells every label key in full, so the locale guard can see it", () => {
    // The reverse locale guard resolves string literals. A key built from `id`
    // would be invisible to it and could rot into an untranslated raw key.
    for (const capability of CHAT_CAPABILITIES) {
      expect(capability.labelKey.startsWith("access.capability.")).toBe(true);
    }
  });

  it("grants nothing to a caller holding nothing", () => {
    // Includes the space-less case: `spaceGrant: undefined` is "not loaded",
    // which must read as no, never as yes.
    expect(Object.values(verdicts(context([])))).toEqual(CHAT_CAPABILITIES.map(() => false));
  });

  it("grants everything to a caller holding every underlying permission", () => {
    expect(Object.values(verdicts(context(EVERYTHING, {})))).toEqual(
      CHAT_CAPABILITIES.map(() => true),
    );
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
      refuses: CHAT_CAPABILITIES.map((c) => c.id).filter((id) => id !== "browseFiles"),
    },
    // `run_and_wait` also needs a run-read permission, so both fall together.
    {
      row: "readRuns",
      removes: ["runs:read", "runs:read-all"],
      refuses: ["runAgents", "composeAgents", "readRuns"],
    },
    { row: "runAgents", removes: ["agents:run"], refuses: ["runAgents"] },
    // Its own grant: `agents:run` does not imply it, nor it `agents:run`.
    { row: "composeAgents", removes: ["agents:run-inline"], refuses: ["composeAgents"] },
    { row: "createAgents", removes: ["agents:write"], refuses: ["createAgents"] },
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
    expect(cases.map((c) => c.row).sort()).toEqual(CHAT_CAPABILITIES.map((c) => c.id).sort());
  });

  it.each(cases)("refuses $row once only its own permission is gone", ({ removes, refuses }) => {
    const without = verdicts(
      context(
        EVERYTHING.filter((p) => !removes.includes(p)),
        {},
      ),
    );
    expect(without).toEqual(
      Object.fromEntries(CHAT_CAPABILITIES.map((c) => [c.id, !refuses.includes(c.id)])),
    );
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
      ...Object.fromEntries(CHAT_CAPABILITIES.map((c) => [c.id, false])),
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
    expect(Object.values(noEndpoint)).toEqual(CHAT_CAPABILITIES.map(() => false));
  });
});

describe("a caller who may read the chat but not write to it", () => {
  it("is shown no capability at all, whatever else they hold", () => {
    // The `viewer` preset: `chat:read` and `mcp:read`, no `chat:write`. The
    // turn itself (`POST /api/chat`) needs `chat:write`, so the assistant
    // never gets the message that would make it act.
    const viewer = verdicts(
      context(["chat:read", "mcp:read", "runs:read", "files:read", "agents:read"], {}),
    );
    expect(Object.values(viewer)).toEqual(CHAT_CAPABILITIES.map(() => false));

    const readOnlyEverything = verdicts(
      context(
        EVERYTHING.filter((p) => p !== "chat:write"),
        {},
      ),
    );
    expect(Object.values(readOnlyEverything)).toEqual(CHAT_CAPABILITIES.map(() => false));
  });
});
