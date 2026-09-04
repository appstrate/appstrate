// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  assertOrgRole,
  effectivePermissions,
  orgPermissions,
  presetPermissions,
  UnmigratedOrgRoleError,
  validateScopes,
  API_KEY_ALLOWED_SCOPES,
} from "../../src/lib/permissions.ts";
import { resolveSpaceRole, spacePermissions } from "../../src/lib/space-role.ts";

/**
 * What `role` reaches in a plain `open` space with the default preset — the
 * shape every request had before space membership existed, and the baseline
 * these grant assertions are written against.
 */
function inDefaultSpace(role: Parameters<typeof orgPermissions>[0]): ReadonlySet<string> {
  const ref = resolveSpaceRole(
    role,
    { id: "spc_test", visibility: "open", defaultRole: "operator" },
    null,
  );
  return effectivePermissions({
    orgPermissions: orgPermissions(role),
    spacePermissions: spacePermissions(ref),
  });
}

describe("effective permissions in an open space", () => {
  it("owner has all permissions", () => {
    const perms = inDefaultSpace("owner");
    expect(perms.has("org:delete")).toBe(true);
    expect(perms.has("members:change-role")).toBe(true);
    expect(perms.has("agents:write")).toBe(true);
  });

  it("admin manages members and settings but never the org's identity", () => {
    const perms = inDefaultSpace("admin");
    expect(perms.has("org:delete")).toBe(false);
    // Renaming/re-slugging is owner-only (RBAC spec §3.4).
    expect(perms.has("org:update")).toBe(false);
    expect(perms.has("org:settings")).toBe(true);
    expect(perms.has("members:change-role")).toBe(true);
    expect(perms.has("agents:write")).toBe(true);
    expect(perms.has("members:invite")).toBe(true);
  });

  it("member can read + run agents + manage own connections", () => {
    const perms = inDefaultSpace("member");
    // Can read
    expect(perms.has("agents:read")).toBe(true);
    expect(perms.has("org:read")).toBe(true);
    expect(perms.has("runs:read")).toBe(true);
    // Can run
    expect(perms.has("agents:run")).toBe(true);
    // Can manage integration connections
    expect(perms.has("integrations:connect")).toBe(true);
    expect(perms.has("integrations:disconnect")).toBe(true);
    // Can cancel runs
    expect(perms.has("runs:cancel")).toBe(true);
    // Can write end-users
    expect(perms.has("end-users:write")).toBe(true);
    // Can run completions through the LLM proxy (powers a member-facing chat —
    // intentionally granted to members, not just admins)
    expect(perms.has("llm-proxy:call")).toBe(true);
    // Can read schedules but not create/edit/delete them (#738 — scheduling,
    // incl. choosing the execution identity, is an admin/owner operation)
    expect(perms.has("schedules:read")).toBe(true);
    expect(perms.has("schedules:write")).toBe(false);
    expect(perms.has("schedules:delete")).toBe(false);
    expect(perms.has("models:read")).toBe(true);
    // Cannot write agents
    expect(perms.has("agents:write")).toBe(false);
    expect(perms.has("agents:configure")).toBe(false);
    expect(perms.has("agents:delete")).toBe(false);
    // Can LIST the role catalog — a space `admin` who is only an org member
    // assigns roles in their space — but never define one.
    expect(perms.has("roles:read")).toBe(true);
    expect(perms.has("roles:write")).toBe(false);
    expect(perms.has("roles:delete")).toBe(false);
    // Cannot manage members
    expect(perms.has("members:invite")).toBe(false);
    expect(perms.has("members:remove")).toBe(false);
    // Cannot manage api-keys
    expect(perms.has("api-keys:read")).toBe(false);
    // Model-provider-keys and webhooks stay admin-only
    expect(perms.has("model-provider-credentials:read")).toBe(false);
    expect(perms.has("webhooks:read")).toBe(false);
  });

  it("guest reaches nothing in a space it was not added to", () => {
    // The whole point of the role: an org identity with no implicit space
    // access. In an OPEN space, where a member would hold the default preset,
    // a guest holds no space-level string at all.
    const perms = inDefaultSpace("guest");
    expect(perms.has("org:read")).toBe(true);
    expect(perms.has("spaces:read")).toBe(true);
    expect(perms.has("llm-proxy:call")).toBe(true);
    // Not even the org directory, nor the role catalog — a guest is an outside
    // collaborator, and roles are the org's own vocabulary.
    expect(perms.has("members:read")).toBe(false);
    expect(perms.has("roles:read")).toBe(false);
    // No space slice whatsoever.
    expect(perms.has("agents:read")).toBe(false);
    expect(perms.has("runs:read")).toBe(false);
    expect(perms.has("chat:read")).toBe(false);
  });

  it("guest added to the space holds exactly the preset it was given", () => {
    const ref = resolveSpaceRole(
      "guest",
      { id: "spc_test", visibility: "closed", defaultRole: "operator" },
      { ref: { kind: "preset", preset: "viewer" } },
    );
    const perms = effectivePermissions({
      orgPermissions: orgPermissions("guest"),
      spacePermissions: spacePermissions(ref),
    });
    expect(perms.has("agents:read")).toBe(true);
    expect(perms.has("agents:run")).toBe(false);
    expect(perms.has("runs:cancel")).toBe(false);
  });

  it("returns a new Set each time (not shared reference)", () => {
    const a = orgPermissions("admin");
    const b = orgPermissions("admin");
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("assertOrgRole", () => {
  it("passes every current role through unchanged", () => {
    for (const role of ["owner", "admin", "member", "guest"] as const) {
      expect(assertOrgRole(role)).toBe(role);
    }
  });

  it("refuses the retired value loudly, naming the migration script", () => {
    // The discriminating half: a role the vocabulary still knows must NOT
    // throw, so a test that only asserted the throw would also pass against a
    // function that throws on everything.
    expect(() => assertOrgRole("member")).not.toThrow();
    expect(() => assertOrgRole("viewer")).toThrow(UnmigratedOrgRoleError);
    expect(() => assertOrgRole("viewer")).toThrow(
      /scripts\/migration\/0008-org-viewer-to-guest\.sql/,
    );
  });
});

describe("effectivePermissions", () => {
  it("applies the credential ceiling to both halves", () => {
    const effective = effectivePermissions({
      orgPermissions: new Set(["org:read", "spaces:read"]),
      spacePermissions: new Set(["agents:read", "agents:write"]),
      scopeCeiling: new Set(["org:read", "agents:read"]),
    });
    expect([...effective].sort()).toEqual(["agents:read", "org:read"]);
  });

  it("leaves the union alone when there is no ceiling (cookie session)", () => {
    const effective = effectivePermissions({
      orgPermissions: new Set(["org:read"]),
      spacePermissions: new Set(["agents:read"]),
    });
    expect([...effective].sort()).toEqual(["agents:read", "org:read"]);
  });

  it("is org-level only when no space has been resolved", () => {
    const effective = effectivePermissions({ orgPermissions: orgPermissions("owner") });
    expect(effective.has("org:delete")).toBe(true);
    // An owner runs every space, but not through a route that has none.
    expect(effective.has("agents:write")).toBe(false);
  });
});

describe("presetPermissions", () => {
  it("orders the four presets viewer ⊂ operator ⊂ builder ⊂ admin", () => {
    const [viewer, operator, builder, admin] = (
      ["viewer", "operator", "builder", "admin"] as const
    ).map((p) => presetPermissions(p));
    for (const [narrow, wide] of [
      [viewer, operator],
      [operator, builder],
      [builder, admin],
    ] as const) {
      for (const perm of narrow!) expect(wide!.has(perm)).toBe(true);
      expect(wide!.size).toBeGreaterThan(narrow!.size);
    }
  });
});

describe("validateScopes", () => {
  it("filters scopes to the creator's effective set + API key allowlist", () => {
    const scopes = ["agents:read", "agents:write", "agents:run"];
    // Admin has all three
    const adminResult = validateScopes(scopes, inDefaultSpace("admin"));
    expect(adminResult).toContain("agents:read");
    expect(adminResult).toContain("agents:write");
    expect(adminResult).toContain("agents:run");
  });

  it("member cannot get agents:write scope", () => {
    const scopes = ["agents:read", "agents:write", "agents:run"];
    const memberResult = validateScopes(scopes, inDefaultSpace("member"));
    expect(memberResult).toContain("agents:read");
    expect(memberResult).toContain("agents:run");
    expect(memberResult).not.toContain("agents:write");
  });

  it("throws on session-only permissions instead of dropping them", () => {
    // org/members are real permissions but session-only: no API key can ever
    // carry them, so asking for one is a caller error, not a narrowing.
    const scopes = ["org:read", "org:delete", "members:invite"];
    expect(() => validateScopes(scopes, inDefaultSpace("owner"))).toThrow(
      /org:read, org:delete, members:invite/,
    );
  });

  it("throws on invalid/unknown scope strings, naming every offender", () => {
    const scopes = ["invalid:scope", "not-a-permission", ""];
    let thrown: unknown;
    try {
      validateScopes(scopes, inDefaultSpace("owner"));
    } catch (err) {
      thrown = err;
    }
    const status = (thrown as { status?: number } | undefined)?.status;
    expect(status).toBe(400);
    expect((thrown as Error).message).toContain("invalid:scope");
    expect((thrown as Error).message).toContain("not-a-permission");
  });

  it("still narrows silently when the scope is real but above the creator", () => {
    // A member cannot delegate what they do not hold — that is a rule, not a
    // typo, and the scopes-omitted default depends on it.
    expect(validateScopes(["agents:read", "agents:write"], inDefaultSpace("member"))).toEqual([
      "agents:read",
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(validateScopes([], inDefaultSpace("admin"))).toHaveLength(0);
  });
});

describe("API-key permissions (scopes as the ceiling)", () => {
  const withScopes = (scopes: string[], role: "admin" | "member") =>
    effectivePermissions({
      orgPermissions: inDefaultSpace(role),
      scopeCeiling: new Set(scopes),
    });

  it("empty scopes returns empty permissions", () => {
    expect(withScopes([], "admin").size).toBe(0);
  });

  it("scoped key returns intersection with the creator's live authority", () => {
    const perms = withScopes(["agents:read", "agents:write", "agents:delete"], "admin");
    expect(perms.has("agents:read")).toBe(true);
    expect(perms.has("agents:write")).toBe(true);
    expect(perms.has("agents:delete")).toBe(true);
    // Not in the scopes
    expect(perms.has("agents:run")).toBe(false);
  });

  it("role downgrade reduces effective permissions", () => {
    // Key has admin-level scopes, but creator was downgraded to member
    const perms = withScopes(["agents:read", "agents:write", "agents:delete"], "member");
    // A member in an open space holds the operator preset: read, not write.
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
      "model-provider-credentials:read",
      "model-provider-credentials:write",
      "model-provider-credentials:delete",
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
      "spaces:read",
      "spaces:write",
      "integrations:read",
      "integrations:connect",
      "integrations:disconnect",
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
