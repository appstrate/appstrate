// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  resolvePermissions,
  hasPermission,
  validateScopes,
  resolveApiKeyPermissions,
  API_KEY_ALLOWED_SCOPES,
} from "../../src/lib/permissions.ts";

describe("resolvePermissions", () => {
  it("owner has all permissions", () => {
    const perms = resolvePermissions("owner");
    expect(perms.has("org:delete")).toBe(true);
    expect(perms.has("members:change-role")).toBe(true);
    expect(perms.has("flows:write")).toBe(true);
    expect(perms.has("billing:manage")).toBe(true);
  });

  it("admin has all except org:delete and members:change-role", () => {
    const perms = resolvePermissions("admin");
    expect(perms.has("org:delete")).toBe(false);
    expect(perms.has("members:change-role")).toBe(false);
    expect(perms.has("org:update")).toBe(true);
    expect(perms.has("flows:write")).toBe(true);
    expect(perms.has("members:invite")).toBe(true);
    expect(perms.has("billing:manage")).toBe(true);
  });

  it("member can read + run flows + manage own connections/schedules", () => {
    const perms = resolvePermissions("member");
    // Can read
    expect(perms.has("flows:read")).toBe(true);
    expect(perms.has("org:read")).toBe(true);
    expect(perms.has("executions:read")).toBe(true);
    // Can run
    expect(perms.has("flows:run")).toBe(true);
    // Can manage connections
    expect(perms.has("connections:connect")).toBe(true);
    expect(perms.has("connections:disconnect")).toBe(true);
    // Can manage schedules
    expect(perms.has("schedules:write")).toBe(true);
    expect(perms.has("schedules:delete")).toBe(true);
    // Can cancel executions
    expect(perms.has("executions:cancel")).toBe(true);
    // Can bind org profiles
    expect(perms.has("org-profiles:bind")).toBe(true);
    // Can write end-users
    expect(perms.has("end-users:write")).toBe(true);
    // Cannot write flows
    expect(perms.has("flows:write")).toBe(false);
    expect(perms.has("flows:configure")).toBe(false);
    expect(perms.has("flows:delete")).toBe(false);
    // Cannot manage members
    expect(perms.has("members:invite")).toBe(false);
    expect(perms.has("members:remove")).toBe(false);
    // Cannot manage infrastructure
    expect(perms.has("models:write")).toBe(false);
    expect(perms.has("provider-keys:read")).toBe(false);
    // Cannot manage api-keys/webhooks
    expect(perms.has("api-keys:read")).toBe(false);
    expect(perms.has("webhooks:read")).toBe(false);
  });

  it("viewer can only read", () => {
    const perms = resolvePermissions("viewer");
    // Can read everything visible
    expect(perms.has("flows:read")).toBe(true);
    expect(perms.has("org:read")).toBe(true);
    expect(perms.has("executions:read")).toBe(true);
    expect(perms.has("models:read")).toBe(true);
    expect(perms.has("billing:read")).toBe(true);
    // Cannot do anything else
    expect(perms.has("flows:write")).toBe(false);
    expect(perms.has("flows:run")).toBe(false);
    expect(perms.has("connections:connect")).toBe(false);
    expect(perms.has("schedules:write")).toBe(false);
    expect(perms.has("executions:cancel")).toBe(false);
    expect(perms.has("org:update")).toBe(false);
    expect(perms.has("org:delete")).toBe(false);
  });

  it("returns a new Set each time (not shared reference)", () => {
    const a = resolvePermissions("admin");
    const b = resolvePermissions("admin");
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("hasPermission", () => {
  it("checks exact resource:action match", () => {
    const perms = new Set(["flows:read", "flows:write"]);
    expect(hasPermission(perms, "flows", "read")).toBe(true);
    expect(hasPermission(perms, "flows", "write")).toBe(true);
    expect(hasPermission(perms, "flows", "delete")).toBe(false);
  });

  it("returns false for empty set", () => {
    const perms = new Set<string>();
    expect(hasPermission(perms, "flows", "read")).toBe(false);
  });
});

describe("validateScopes", () => {
  it("filters scopes to creator role permissions + API key allowlist", () => {
    const scopes = ["flows:read", "flows:write", "flows:run"];
    // Admin has all three
    const adminResult = validateScopes(scopes, "admin");
    expect(adminResult).toContain("flows:read");
    expect(adminResult).toContain("flows:write");
    expect(adminResult).toContain("flows:run");
  });

  it("member cannot get flows:write scope", () => {
    const scopes = ["flows:read", "flows:write", "flows:run"];
    const memberResult = validateScopes(scopes, "member");
    expect(memberResult).toContain("flows:read");
    expect(memberResult).toContain("flows:run");
    expect(memberResult).not.toContain("flows:write");
  });

  it("rejects session-only permissions", () => {
    const scopes = ["org:read", "org:delete", "members:invite", "billing:manage"];
    const ownerResult = validateScopes(scopes, "owner");
    // All org/members/billing are session-only, excluded from API keys
    expect(ownerResult).toHaveLength(0);
  });

  it("rejects invalid/unknown scope strings", () => {
    const scopes = ["invalid:scope", "not-a-permission", ""];
    const result = validateScopes(scopes, "owner");
    expect(result).toHaveLength(0);
  });

  it("returns empty array for empty input", () => {
    expect(validateScopes([], "admin")).toHaveLength(0);
  });
});

describe("resolveApiKeyPermissions", () => {
  it("empty scopes returns empty permissions", () => {
    const perms = resolveApiKeyPermissions([], "admin");
    expect(perms.size).toBe(0);
  });

  it("scoped key returns intersection with current role", () => {
    const perms = resolveApiKeyPermissions(["flows:read", "flows:write", "flows:delete"], "admin");
    expect(perms.has("flows:read")).toBe(true);
    expect(perms.has("flows:write")).toBe(true);
    expect(perms.has("flows:delete")).toBe(true);
    // Not in the scopes
    expect(perms.has("models:write")).toBe(false);
  });

  it("role downgrade reduces effective permissions", () => {
    // Key has admin-level scopes, but creator was downgraded to member
    const perms = resolveApiKeyPermissions(["flows:read", "flows:write", "flows:delete"], "member");
    // Member has flows:read but not flows:write or flows:delete
    expect(perms.has("flows:read")).toBe(true);
    expect(perms.has("flows:write")).toBe(false);
    expect(perms.has("flows:delete")).toBe(false);
  });
});

describe("API_KEY_ALLOWED_SCOPES", () => {
  it("excludes session-only permissions", () => {
    const excluded = [
      "org:read",
      "org:update",
      "org:delete",
      "members:read",
      "members:invite",
      "members:remove",
      "members:change-role",
      "billing:read",
      "billing:manage",
      "api-keys:read",
      "api-keys:create",
      "api-keys:revoke",
      "provider-keys:read",
      "provider-keys:write",
      "provider-keys:delete",
      "profiles:read",
      "profiles:write",
      "profiles:delete",
      "org-profiles:read",
      "org-profiles:write",
      "org-profiles:delete",
      "org-profiles:bind",
      "connections:read",
      "connections:connect",
      "connections:disconnect",
      "memories:read",
      "memories:delete",
    ];
    for (const perm of excluded) {
      expect(API_KEY_ALLOWED_SCOPES.has(perm as never)).toBe(false);
    }
  });

  it("includes headless-relevant permissions", () => {
    const included = [
      "flows:read",
      "flows:write",
      "flows:run",
      "executions:read",
      "executions:cancel",
      "end-users:read",
      "end-users:write",
      "end-users:delete",
      "webhooks:read",
      "webhooks:write",
      "webhooks:delete",
      "applications:read",
      "applications:write",
    ];
    for (const perm of included) {
      expect(API_KEY_ALLOWED_SCOPES.has(perm as never)).toBe(true);
    }
  });
});
