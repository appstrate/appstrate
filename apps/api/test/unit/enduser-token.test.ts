// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { scopesToPermissions } from "../../src/services/enduser-token.ts";

describe("scopesToPermissions", () => {
  it("returns empty set for undefined scope", () => {
    const perms = scopesToPermissions(undefined);
    expect(perms.size).toBe(0);
  });

  it("returns empty set for empty string", () => {
    const perms = scopesToPermissions("");
    expect(perms.size).toBe(0);
  });

  it("maps connections scope to connections:read", () => {
    const perms = scopesToPermissions("openid connections");
    expect(perms.has("connections:read")).toBe(true);
    expect(perms.has("connections:write")).toBe(false);
  });

  it("maps connections:write scope to both read and write", () => {
    const perms = scopesToPermissions("openid connections:write");
    expect(perms.has("connections:read")).toBe(true);
    expect(perms.has("connections:write")).toBe(true);
  });

  it("maps runs scope to runs:read", () => {
    const perms = scopesToPermissions("openid runs");
    expect(perms.has("runs:read")).toBe(true);
    expect(perms.has("runs:write")).toBe(false);
  });

  it("maps runs:write scope to both read and write", () => {
    const perms = scopesToPermissions("openid runs:write");
    expect(perms.has("runs:read")).toBe(true);
    expect(perms.has("runs:write")).toBe(true);
  });

  it("ignores openid, profile, email scopes (no resource permissions)", () => {
    const perms = scopesToPermissions("openid profile email");
    expect(perms.size).toBe(0);
  });

  it("combines multiple scopes", () => {
    const perms = scopesToPermissions("openid connections runs:write");
    expect(perms.has("connections:read")).toBe(true);
    expect(perms.has("runs:read")).toBe(true);
    expect(perms.has("runs:write")).toBe(true);
    expect(perms.size).toBe(3);
  });
});
