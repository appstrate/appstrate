// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { scopesToPermissions } from "../../auth/claims.ts";

describe("scopesToPermissions", () => {
  it("returns an empty set for undefined / empty scope", () => {
    expect(scopesToPermissions(undefined).size).toBe(0);
    expect(scopesToPermissions("").size).toBe(0);
    expect(scopesToPermissions("   ").size).toBe(0);
  });

  it("drops identity-only scopes (openid profile email)", () => {
    expect(scopesToPermissions("openid profile email").size).toBe(0);
  });

  it("maps `runs` to read-only", () => {
    const perms = scopesToPermissions("runs");
    expect([...perms].sort()).toEqual(["runs:read"]);
  });

  it("maps `runs:write` to read + cancel (write is a superset)", () => {
    const perms = scopesToPermissions("runs:write");
    expect([...perms].sort()).toEqual(["runs:cancel", "runs:read"]);
  });

  it("maps `agents:write` to read + run", () => {
    const perms = scopesToPermissions("agents:write");
    expect([...perms].sort()).toEqual(["agents:read", "agents:run"]);
  });

  it("maps `connections:write` to read + connect + disconnect", () => {
    const perms = scopesToPermissions("connections:write");
    expect([...perms].sort()).toEqual([
      "connections:connect",
      "connections:disconnect",
      "connections:read",
    ]);
  });

  it("merges multiple scopes into a single permission set", () => {
    const perms = scopesToPermissions("openid runs agents:write");
    expect([...perms].sort()).toEqual(["agents:read", "agents:run", "runs:read"]);
  });

  it("ignores unknown scopes silently", () => {
    const perms = scopesToPermissions("runs totally:unknown other:scope");
    expect([...perms]).toEqual(["runs:read"]);
  });

  it("splits on any whitespace, not just single spaces", () => {
    const perms = scopesToPermissions("runs\tagents");
    expect([...perms].sort()).toEqual(["agents:read", "runs:read"]);
  });
});
