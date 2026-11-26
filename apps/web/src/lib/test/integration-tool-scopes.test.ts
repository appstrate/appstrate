// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  countToolsWithoutScopes,
  hasOAuthAuth,
  isToolWithoutPermission,
} from "../integration-tool-scopes.ts";

describe("countToolsWithoutScopes", () => {
  it("counts the available tools with no required scope", () => {
    expect(
      countToolsWithoutScopes([
        { status: "available" },
        { status: "available", permissions: {} },
        { status: "available", permissions: { oauth: [] } },
        { status: "available", permissions: { oauth: ["mail.read"] } },
      ]),
    ).toBe(3);
  });

  it("ignores tools an agent cannot call", () => {
    expect(
      countToolsWithoutScopes([
        { status: "pending" },
        { status: "missing" },
        { status: "blocked" },
      ]),
    ).toBe(0);
  });
});

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
