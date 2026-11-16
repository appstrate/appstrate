// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { callSpaceOf } from "../src/ui/conversation-scope.ts";

describe("callSpaceOf", () => {
  it("reads the stamp the engine put on the call", () => {
    expect(callSpaceOf({ providerMetadata: { appstrate: { spaceId: "spc_a" } }, args: {} })).toBe(
      "spc_a",
    );
  });

  it("prefers the stamp over the space the arguments name", () => {
    expect(
      callSpaceOf({
        providerMetadata: { appstrate: { spaceId: "spc_origin" } },
        args: { space_id: "spc_other" },
      }),
    ).toBe("spc_origin");
  });

  it("falls back to the space_id the call names when it carries no stamp", () => {
    expect(callSpaceOf({ args: { operation_id: "x", space_id: "spc_b" } })).toBe("spc_b");
    expect(callSpaceOf({ providerMetadata: {}, args: { space_id: "spc_b" } })).toBe("spc_b");
  });

  it("is undefined when neither exists", () => {
    expect(callSpaceOf({})).toBeUndefined();
    expect(callSpaceOf({ args: { operation_id: "x" } })).toBeUndefined();
    expect(callSpaceOf({ providerMetadata: { appstrate: {} }, args: { space_id: "" } })).toBe(
      undefined,
    );
    expect(callSpaceOf({ args: null })).toBeUndefined();
  });
});
