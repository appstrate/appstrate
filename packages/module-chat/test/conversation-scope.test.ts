// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { callSpaceOf, conversationTurnCan } from "../src/ui/conversation-scope.ts";

describe("callSpaceOf", () => {
  it("reads the stamp the engine put on the call", () => {
    expect(callSpaceOf({ providerMetadata: { appstrate: { spaceId: "spc_a" } } })).toBe("spc_a");
  });

  it("never reads the space the call's arguments name", () => {
    const named = { args: { operation_id: "x", space_id: "spc_b" } };
    expect(callSpaceOf(named)).toBeUndefined();
    expect(callSpaceOf({ ...named, providerMetadata: {} })).toBeUndefined();
    expect(
      callSpaceOf({ ...named, providerMetadata: { appstrate: { spaceId: "spc_origin" } } }),
    ).toBe("spc_origin");
  });

  it("is undefined without a usable stamp", () => {
    expect(callSpaceOf({})).toBeUndefined();
    expect(callSpaceOf({ providerMetadata: { appstrate: {} } })).toBeUndefined();
    expect(callSpaceOf({ providerMetadata: { appstrate: { spaceId: "" } } })).toBeUndefined();
  });
});

describe("the composer of a limited conversation", () => {
  it("offers only actions its origin can perform, and goes read-only when that origin is no longer in the acting set", () => {
    const host = {
      actingSpaceIds: ["origin", "other"],
      can: () => true,
      canIn: (space: string, permission: string) =>
        space === "origin" && permission === "chat:write",
    };
    const scope = { originSpaceId: "origin", restricted: true };
    expect(conversationTurnCan(scope, host)("chat:write")).toBe(true);
    expect(conversationTurnCan(scope, host)("skills:read")).toBe(false);
    expect(conversationTurnCan(scope, { ...host, actingSpaceIds: ["other"] })("chat:write")).toBe(
      false,
    );
    expect(conversationTurnCan({ ...scope, restricted: false }, host)("skills:read")).toBe(true);
  });
});
