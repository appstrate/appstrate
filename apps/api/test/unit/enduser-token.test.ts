// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  scopesToPermissions,
  resolveEndUserPermissionsFromClaims,
} from "../../src/services/enduser-token.ts";

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

describe("resolveEndUserPermissionsFromClaims", () => {
  it("uses role-based permissions when role is present", () => {
    const perms = resolveEndUserPermissionsFromClaims({
      authUserId: "u1",
      role: "member",
    });
    expect(perms.has("agents:read")).toBe(true);
    expect(perms.has("agents:run")).toBe(true);
    expect(perms.has("connections:connect")).toBe(true);
  });

  it("falls back to scope-based for legacy tokens (no role)", () => {
    const perms = resolveEndUserPermissionsFromClaims({
      authUserId: "u1",
      scope: "openid runs",
    });
    expect(perms.has("runs:read")).toBe(true);
    expect(perms.has("agents:read")).toBe(false);
  });

  it("intersects role and scope when both present (scope = ceiling)", () => {
    const perms = resolveEndUserPermissionsFromClaims({
      authUserId: "u1",
      role: "member",
      scope: "openid runs",
    });
    // member has agents:read + runs:read + connections:*, but scope only grants runs:read
    expect(perms.has("runs:read")).toBe(true);
    expect(perms.has("agents:read")).toBe(false);
    expect(perms.has("connections:read")).toBe(false);
  });

  it("uses full role perms when scope is identity-only (first-party pattern)", () => {
    const perms = resolveEndUserPermissionsFromClaims({
      authUserId: "u1",
      role: "admin",
      scope: "openid profile email",
    });
    // Identity scopes produce empty scopePerms → full role permissions
    expect(perms.has("agents:read")).toBe(true);
    expect(perms.has("end-users:write")).toBe(true);
    expect(perms.has("schedules:read")).toBe(true);
  });

  it("falls back to scope-based for invalid role value", () => {
    const perms = resolveEndUserPermissionsFromClaims({
      authUserId: "u1",
      role: "superadmin",
      scope: "openid runs",
    });
    expect(perms.has("runs:read")).toBe(true);
    expect(perms.has("agents:read")).toBe(false);
  });

  it("viewer role limits permissions", () => {
    const perms = resolveEndUserPermissionsFromClaims({
      authUserId: "u1",
      role: "viewer",
    });
    expect(perms.has("agents:read")).toBe(true);
    expect(perms.has("runs:read")).toBe(true);
    expect(perms.has("agents:run")).toBe(false);
    expect(perms.size).toBe(2);
  });

  it("uses full role perms when no scope at all", () => {
    const perms = resolveEndUserPermissionsFromClaims({
      authUserId: "u1",
      role: "member",
    });
    expect(perms.has("agents:read")).toBe(true);
    expect(perms.has("agents:run")).toBe(true);
    expect(perms.has("connections:connect")).toBe(true);
    expect(perms.has("end-users:read")).toBe(false); // member doesn't have this
  });
});
