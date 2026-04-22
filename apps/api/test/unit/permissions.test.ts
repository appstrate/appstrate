// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  resolvePermissions,
  validateScopes,
  resolveApiKeyPermissions,
  API_KEY_ALLOWED_SCOPES,
} from "../../src/lib/permissions.ts";

describe("resolvePermissions", () => {
  it("owner has all permissions", () => {
    const perms = resolvePermissions("owner");
    expect(perms.has("org:delete")).toBe(true);
    expect(perms.has("members:change-role")).toBe(true);
    expect(perms.has("agents:write")).toBe(true);
  });

  it("admin has all except org:delete and members:change-role", () => {
    const perms = resolvePermissions("admin");
    expect(perms.has("org:delete")).toBe(false);
    expect(perms.has("members:change-role")).toBe(false);
    expect(perms.has("org:update")).toBe(true);
    expect(perms.has("agents:write")).toBe(true);
    expect(perms.has("members:invite")).toBe(true);
  });

  it("member can read + run agents + manage own connections", () => {
    const perms = resolvePermissions("member");
    // Can read
    expect(perms.has("agents:read")).toBe(true);
    expect(perms.has("org:read")).toBe(true);
    expect(perms.has("runs:read")).toBe(true);
    // Can run
    expect(perms.has("agents:run")).toBe(true);
    // Can manage connections
    expect(perms.has("connections:connect")).toBe(true);
    expect(perms.has("connections:disconnect")).toBe(true);
    // Can cancel runs
    expect(perms.has("runs:cancel")).toBe(true);
    // Can bind org profiles
    expect(perms.has("app-profiles:bind")).toBe(true);
    // Can write end-users
    expect(perms.has("end-users:write")).toBe(true);
    // Module-owned permissions still part of the core taxonomy
    expect(perms.has("schedules:write")).toBe(true);
    expect(perms.has("models:read")).toBe(true);
    // Cannot write agents
    expect(perms.has("agents:write")).toBe(false);
    expect(perms.has("agents:configure")).toBe(false);
    expect(perms.has("agents:delete")).toBe(false);
    // Cannot manage members
    expect(perms.has("members:invite")).toBe(false);
    expect(perms.has("members:remove")).toBe(false);
    // Cannot manage api-keys
    expect(perms.has("api-keys:read")).toBe(false);
    // Provider-keys and webhooks stay admin-only
    expect(perms.has("provider-keys:read")).toBe(false);
    expect(perms.has("webhooks:read")).toBe(false);
  });

  it("viewer can only read", () => {
    const perms = resolvePermissions("viewer");
    // Can read everything visible
    expect(perms.has("agents:read")).toBe(true);
    expect(perms.has("org:read")).toBe(true);
    expect(perms.has("runs:read")).toBe(true);
    // Module-owned read permissions included in viewer
    expect(perms.has("schedules:read")).toBe(true);
    expect(perms.has("models:read")).toBe(true);
    // Cannot do anything else
    expect(perms.has("agents:write")).toBe(false);
    expect(perms.has("agents:run")).toBe(false);
    expect(perms.has("connections:connect")).toBe(false);
    expect(perms.has("runs:cancel")).toBe(false);
    expect(perms.has("org:update")).toBe(false);
    expect(perms.has("org:delete")).toBe(false);
    expect(perms.has("webhooks:read")).toBe(false);
  });

  it("returns a new Set each time (not shared reference)", () => {
    const a = resolvePermissions("admin");
    const b = resolvePermissions("admin");
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("validateScopes", () => {
  it("filters scopes to creator role permissions + API key allowlist", () => {
    const scopes = ["agents:read", "agents:write", "agents:run"];
    // Admin has all three
    const adminResult = validateScopes(scopes, "admin");
    expect(adminResult).toContain("agents:read");
    expect(adminResult).toContain("agents:write");
    expect(adminResult).toContain("agents:run");
  });

  it("member cannot get agents:write scope", () => {
    const scopes = ["agents:read", "agents:write", "agents:run"];
    const memberResult = validateScopes(scopes, "member");
    expect(memberResult).toContain("agents:read");
    expect(memberResult).toContain("agents:run");
    expect(memberResult).not.toContain("agents:write");
  });

  it("rejects session-only permissions", () => {
    const scopes = ["org:read", "org:delete", "members:invite"];
    const ownerResult = validateScopes(scopes, "owner");
    // org/members are session-only, excluded from API keys
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
    const perms = resolveApiKeyPermissions(
      ["agents:read", "agents:write", "agents:delete"],
      "admin",
    );
    expect(perms.has("agents:read")).toBe(true);
    expect(perms.has("agents:write")).toBe(true);
    expect(perms.has("agents:delete")).toBe(true);
    // Not in the scopes
    expect(perms.has("agents:run")).toBe(false);
  });

  it("role downgrade reduces effective permissions", () => {
    // Key has admin-level scopes, but creator was downgraded to member
    const perms = resolveApiKeyPermissions(
      ["agents:read", "agents:write", "agents:delete"],
      "member",
    );
    // Member has agents:read but not agents:write or agents:delete
    expect(perms.has("agents:read")).toBe(true);
    expect(perms.has("agents:write")).toBe(false);
    expect(perms.has("agents:delete")).toBe(false);
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
      "api-keys:read",
      "api-keys:create",
      "api-keys:revoke",
      "profiles:read",
      "profiles:write",
      "profiles:delete",
      "app-profiles:read",
      "app-profiles:write",
      "app-profiles:delete",
      "app-profiles:bind",
      "memories:read",
      "memories:delete",
      "provider-keys:read",
      "provider-keys:write",
      "provider-keys:delete",
    ];
    for (const perm of excluded) {
      expect(API_KEY_ALLOWED_SCOPES.has(perm as never)).toBe(false);
    }
  });

  it("includes headless-relevant core permissions", () => {
    const included = [
      "agents:read",
      "agents:write",
      "agents:run",
      "runs:read",
      "runs:cancel",
      "end-users:read",
      "end-users:write",
      "end-users:delete",
      "applications:read",
      "applications:write",
      "connections:read",
      "connections:connect",
      "connections:disconnect",
      "schedules:read",
      "schedules:write",
      "schedules:delete",
      "models:read",
      "models:write",
      "models:delete",
    ];
    for (const perm of included) {
      expect(API_KEY_ALLOWED_SCOPES.has(perm as never)).toBe(true);
    }
  });

  it("excludes module-owned permissions — those are layered in at boot via getApiKeyAllowedScopes()", () => {
    // webhooks:*, oauth-clients:*, and billing:* are module-contributed
    // (webhooks + oidc + cloud modules respectively). `apiKeyGrantable`
    // is opted-in per contribution, merged into the dynamic view by
    // `getApiKeyAllowedScopes()`. The core constant must not carry them
    // — otherwise disabling the owning module would leave dead scope
    // strings bound to API-key creation.
    const moduleOwned = [
      "webhooks:read",
      "webhooks:write",
      "webhooks:delete",
      "oauth-clients:read",
      "oauth-clients:write",
      "oauth-clients:delete",
      "billing:read",
      "billing:manage",
    ];
    for (const perm of moduleOwned) {
      expect(API_KEY_ALLOWED_SCOPES.has(perm as never)).toBe(false);
    }
  });
});
