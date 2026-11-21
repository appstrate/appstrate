// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { Context } from "hono";
import type { AppEnv } from "../../../src/types/index.ts";
import { connectionPrincipal, writesDelegated } from "../../../src/lib/connection-principal.ts";
import { connectOfferPolicyFromRequest } from "../../../src/lib/connect-offer-policy.ts";
import { RUN_CONNECT_OFFERS_HEADER } from "@appstrate/core/run-and-wait-client";
import { connectionCaller } from "../../../src/routes/integrations.ts";

/** A context exposing only the variables the connection doors read. */
function contextOf(
  vars: Record<string, unknown>,
  headers: Record<string, string> = {},
): Context<AppEnv> {
  const all: Record<string, unknown> = { user: { id: "usr_1" }, orgId: "org_1", ...vars };
  return {
    get: (key: string) => all[key],
    req: { header: (name: string) => headers[name] },
  } as unknown as Context<AppEnv>;
}

// actor kind x pin x allowlist (absent | restricted | unrestricted) -> who writes, and the scope.
const SCOPE_TRUTH_TABLE: {
  name: string;
  vars: Record<string, unknown>;
  kind: "person" | "delegated";
  /** `null`: unbound; `spaceIds: null`: bound to the org alone. */
  binding: { orgId: string; spaceIds: string[] | null } | null;
  delegated: boolean;
}[] = [
  {
    name: "web session",
    vars: { principalKind: "user" },
    kind: "person",
    binding: null,
    delegated: false,
  },
  {
    name: "chat, unlimited conversation",
    vars: {
      principalKind: "user",
      credentialSpaceIds: ["spc_a", "spc_b"],
      credentialSpaceIdsRestricted: false,
    },
    kind: "person",
    binding: { orgId: "org_1", spaceIds: null },
    delegated: false,
  },
  {
    name: "chat, limited conversation",
    vars: { principalKind: "user", credentialSpaceIds: ["spc_a"] },
    kind: "person",
    binding: { orgId: "org_1", spaceIds: ["spc_a"] },
    delegated: true,
  },
  {
    name: "pinned MCP token",
    vars: { principalKind: "user", credentialSpaceId: "spc_a" },
    kind: "person",
    binding: { orgId: "org_1", spaceIds: ["spc_a"] },
    delegated: true,
  },
  {
    name: "pin beats an unrestricted allowlist",
    vars: {
      principalKind: "user",
      credentialSpaceId: "spc_a",
      credentialSpaceIds: ["spc_a"],
      credentialSpaceIdsRestricted: false,
    },
    kind: "person",
    binding: { orgId: "org_1", spaceIds: ["spc_a"] },
    delegated: true,
  },
  {
    name: "API key",
    vars: { principalKind: "delegate", credentialSpaceId: "spc_a" },
    kind: "delegated",
    binding: { orgId: "org_1", spaceIds: ["spc_a"] },
    delegated: true,
  },
  {
    name: "end-user",
    vars: { principalKind: "end_user" },
    kind: "delegated",
    binding: { orgId: "org_1", spaceIds: null },
    delegated: true,
  },
  {
    name: "delegate with an unrestricted flag",
    vars: {
      principalKind: "delegate",
      credentialSpaceIds: ["spc_a"],
      credentialSpaceIdsRestricted: false,
    },
    kind: "delegated",
    binding: { orgId: "org_1", spaceIds: ["spc_a"] },
    delegated: true,
  },
];

describe("connection scope truth table (principal, scope rule, connect offer)", () => {
  for (const row of SCOPE_TRUTH_TABLE) {
    it(row.name, () => {
      const principal = connectionPrincipal(contextOf(row.vars));
      expect(principal.kind).toBe(row.kind);
      expect(principal.binding).toEqual(row.binding);
      expect(writesDelegated(principal)).toBe(row.delegated);
      const policy = connectOfferPolicyFromRequest(
        contextOf({ ...row.vars, permissions: new Set() }, { [RUN_CONNECT_OFFERS_HEADER]: "1" }),
      );
      expect(policy?.delegated).toBe(row.delegated);
    });
  }
});

describe("connectionPrincipal", () => {
  it("an unconfined user principal is an unbound person", () => {
    const principal = connectionPrincipal(contextOf({ principalKind: "user" }));
    expect(principal).toEqual({
      kind: "person",
      actor: { type: "user", id: "usr_1" },
      binding: null,
    });
  });

  it("a user principal pinned to a space (a space-bound MCP instance token) is bound to the pin", () => {
    const principal = connectionPrincipal(
      contextOf({ principalKind: "user", credentialSpaceId: "spc_a" }),
    );
    expect(principal.kind).toBe("person");
    expect(principal.binding).toEqual({ orgId: "org_1", spaceIds: ["spc_a"] });
  });

  it("a user principal carrying an allowlist is bound to the allowlist", () => {
    const principal = connectionPrincipal(
      contextOf({ principalKind: "user", credentialSpaceIds: ["spc_a", "spc_b"] }),
    );
    expect(principal.kind).toBe("person");
    expect(principal.binding).toEqual({ orgId: "org_1", spaceIds: ["spc_a", "spc_b"] });
  });

  it("a pin and an allowlist bind to the spaces both admit", () => {
    const inBoth = connectionPrincipal(
      contextOf({
        principalKind: "user",
        credentialSpaceId: "spc_b",
        credentialSpaceIds: ["spc_a", "spc_b"],
      }),
    );
    expect(inBoth.binding).toEqual({ orgId: "org_1", spaceIds: ["spc_b"] });

    const disjoint = connectionPrincipal(
      contextOf({
        principalKind: "user",
        credentialSpaceId: "spc_c",
        credentialSpaceIds: ["spc_a", "spc_b"],
      }),
    );
    expect(disjoint.binding).toEqual({ orgId: "org_1", spaceIds: [] });
  });

  it("a delegated credential is bound to its org, and to the space it pins", () => {
    const unpinned = connectionPrincipal(contextOf({ principalKind: "delegate" }));
    expect(unpinned).toMatchObject({
      kind: "delegated",
      binding: { orgId: "org_1", spaceIds: null },
    });
    const pinned = connectionPrincipal(
      contextOf({ principalKind: "delegate", credentialSpaceId: "spc_a" }),
    );
    expect(pinned).toMatchObject({
      kind: "delegated",
      binding: { orgId: "org_1", spaceIds: ["spc_a"] },
    });
  });
});

describe("connectionCaller (the connection doors' caller)", () => {
  it("under a space allowlist, admits the listed spaces alone and never consents to every space", () => {
    const caller = connectionCaller(
      contextOf({
        principalKind: "user",
        credentialSpaceIds: ["spc_a", "spc_b"],
        permissions: new Set(["integrations:connect"]),
      }),
      null,
    );
    expect(caller.principal.binding).toEqual({ orgId: "org_1", spaceIds: ["spc_a", "spc_b"] });
    expect(caller.admitsSpace("spc_a")).toBe(true);
    expect(caller.admitsSpace("spc_b")).toBe(true);
    expect(caller.admitsSpace("spc_c")).toBe(false);
    expect(caller.canShareAllSpaces?.("org_1")).toBe(false);
  });

  it("unconfined, admits any space and consents to every space under its ceiling", () => {
    const caller = connectionCaller(contextOf({ principalKind: "user" }), null);
    expect(caller.principal.binding).toBeNull();
    expect(caller.admitsSpace("spc_c")).toBe(true);
    expect(caller.canShareAllSpaces?.("org_1")).toBe(true);
  });
});
