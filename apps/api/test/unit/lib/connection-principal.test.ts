// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { Context } from "hono";
import type { AppEnv } from "../../../src/types/index.ts";
import { connectionPrincipal } from "../../../src/lib/connection-principal.ts";
import { connectionCaller } from "../../../src/routes/integrations.ts";

/** A context exposing only the variables the connection doors read. */
function contextOf(vars: Record<string, unknown>): Context<AppEnv> {
  const all: Record<string, unknown> = { user: { id: "usr_1" }, orgId: "org_1", ...vars };
  return { get: (key: string) => all[key] } as unknown as Context<AppEnv>;
}

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
