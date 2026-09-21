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
  INTEGRATION_ACTIVATE_PERMISSION,
  resolveChatCapabilities,
  type ChatAccessContext,
} from "./chat-access.ts";
import type { SpaceGrant } from "../../lib/package-permissions.ts";

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

/** Every permission any row reads — a caller who holds the lot. */
const EVERYTHING = [
  "mcp:invoke",
  "agents:run",
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

describe("seeing runs", () => {
  it("is granted by either run-read permission", () => {
    // `read-all` is the WIDER of the two and implies `read` (RBAC spec §3.4).
    // A row asking only for `read` would tell a space supervisor it cannot see
    // runs, which is the opposite of true.
    expect(verdicts(context(["runs:read"])).readRuns).toBe(true);
    expect(verdicts(context(["runs:read-all"])).readRuns).toBe(true);
    expect(verdicts(context([])).readRuns).toBe(false);
  });
});

describe("activating an integration", () => {
  it("is granted in a TEAM space only with the activation grant", () => {
    expect(
      verdicts(context([INTEGRATION_ACTIVATE_PERMISSION], { personal: false }))
        .activateIntegrations,
    ).toBe(true);
    expect(verdicts(context([], { personal: false })).activateIntegrations).toBe(false);
  });

  it("is granted in the caller's PERSONAL space WITHOUT that permission", () => {
    // RBAC spec §3.6: the owner of a personal space holds `operator` there,
    // which carries no activation grant — and the route accepts anyway. A row
    // keyed on the bare permission would claim a refusal that never happens.
    expect(verdicts(context([], { personal: true, access: "member" })).activateIntegrations).toBe(
      true,
    );
  });

  it("is NOT granted by a personal space the caller cannot enter", () => {
    // `personal && access === "member"` is what stands in for "this one is
    // mine" — the owner's id is deliberately absent from the wire. Dropping
    // the second half would hand every personal space to every caller.
    expect(verdicts(context([], { personal: true, access: "none" })).activateIntegrations).toBe(
      false,
    );
  });

  it("is distinct from connecting an account", () => {
    // The distinction the chat's own system prompt has to explain when an
    // `integration_not_active` error lands: connecting is personal, activating
    // is organization-wide. Holding one must never light up the other.
    const connector = verdicts(context(["integrations:connect"], { personal: false }));
    expect(connector.connectIntegrations).toBe(true);
    expect(connector.activateIntegrations).toBe(false);
  });
});

describe("reaching the API at all", () => {
  it("is the `mcp:invoke` row, independent of every package permission", () => {
    // Without it the assistant answers from its own words — the single most
    // useful thing to know, and it must not be implied by holding agents.
    const runner = verdicts(context(["agents:run", "runs:read", "files:read"]));
    expect(runner.runAgents).toBe(true);
    expect(runner.callApi).toBe(false);
  });
});
