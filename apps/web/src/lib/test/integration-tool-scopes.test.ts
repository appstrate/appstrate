// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { hasOAuthAuth, isToolWithoutPermission } from "../integration-tool-scopes.ts";

describe("isToolWithoutPermission", () => {
  it("holds for an available tool whatever its origin, with no scope listed", () => {
    expect(isToolWithoutPermission({})).toBe(true);
    expect(isToolWithoutPermission({ status: "available", permissions: {} })).toBe(true);
    expect(isToolWithoutPermission({ status: "available", permissions: { a: [] } })).toBe(true);
  });

  it("fails for a tool with a scope or one an agent cannot call", () => {
    expect(isToolWithoutPermission({ permissions: { a: ["read"] } })).toBe(false);
    expect(isToolWithoutPermission({ status: "pending" })).toBe(false);
  });
});

describe("hasOAuthAuth", () => {
  it("is true only for an OAuth auth", () => {
    expect(hasOAuthAuth([{ type: "api_key" }, { type: "oauth2" }])).toBe(true);
    expect(hasOAuthAuth([{ type: "api_key" }, { type: "basic" }])).toBe(false);
    expect(hasOAuthAuth([])).toBe(false);
  });
});
