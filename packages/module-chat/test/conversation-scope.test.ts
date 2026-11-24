// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { callSpaceOf } from "../src/ui/conversation-scope.ts";

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

  it("prefers the resolved target and honors an organization-only receipt", () => {
    const providerMetadata = { appstrate: { spaceId: "spc_caller" } };
    expect(
      callSpaceOf({ providerMetadata, result: { actedSpaceIds: ["spc_caller", "spc_target"] } }),
    ).toBe("spc_target");
    expect(callSpaceOf({ providerMetadata, result: { actedSpaceIds: [] } })).toBeUndefined();
  });

  it("is undefined without a usable stamp", () => {
    expect(callSpaceOf({})).toBeUndefined();
    expect(callSpaceOf({ providerMetadata: { appstrate: {} } })).toBeUndefined();
    expect(callSpaceOf({ providerMetadata: { appstrate: { spaceId: "" } } })).toBeUndefined();
  });
});
