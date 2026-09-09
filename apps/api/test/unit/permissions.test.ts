// SPDX-License-Identifier: Apache-2.0

import {
  SPACE_LEVEL_PERMISSIONS,
  type OrgRole,
  type SpaceLevelPermission,
} from "@appstrate/core/permissions";
import { describe, it, expect } from "bun:test";
import {
  effectivePermissions,
  orgPermissions,
  presetPermissions,
  validateScopes,
  API_KEY_ALLOWED_SCOPES,
  type Permission,
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

describe("orgPermissions", () => {
  it("refuses a role outside the vocabulary rather than defaulting it", () => {
    // A persisted value the code does not know must fail, not resolve to an
    // empty (or any) set — silently under- or over-granting is the one thing
    // this table may never do.
    expect(() => orgPermissions("nope" as OrgRole)).toThrow();
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
  it("nests the read chain viewer ⊂ operator ⊂ builder ⊂ admin", () => {
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

describe("the `runner` preset", () => {
  /**
   * Spelled out rather than derived: a runner launches agents it may not read,
   * so its set is the one preset that cannot be filtered out of a neighbour.
   * The list is asserted whole, so widening it anywhere is a diff in this file.
   *
   * `presetPermissions` answers the MERGED matrix — core plus whatever the
   * loaded modules contributed to `runner` — so each assertion here is scoped
   * to `SPACE_LEVEL_PERMISSIONS`, the core space vocabulary. What the modules
   * add is the subject of the last test in this block.
   */
  const RUNNER_GRANTS: Permission[] = [
    "agents:run",
    "files:read",
    "integrations:connect",
    "integrations:disconnect",
    "integrations:read",
    "persistence:read",
    "runs:cancel",
    "runs:read",
  ];

  /** The half of a preset's set that core defines, module contributions removed. */
  function coreGrants(preset: Parameters<typeof presetPermissions>[0]): Permission[] {
    return [...presetPermissions(preset)]
      .filter((p) => SPACE_LEVEL_PERMISSIONS.has(p as SpaceLevelPermission))
      .sort();
  }

  it("holds exactly the eight core space-level grants it is defined by", () => {
    expect(coreGrants("runner")).toEqual(RUNNER_GRANTS);
  });

  it("withholds every read that would expose what it launches", () => {
    const runner = presetPermissions("runner");
    // The point of the preset (RBAC spec §3.3): the agent's content, the
    // packages it is built from, who else runs what, and any mutation at all.
    const withheldGrants: Permission[] = [
      "agents:read",
      "skills:read",
      "mcp-servers:read",
      "schedules:read",
      "end-users:read",
      "end-users:write",
      "runs:read-all",
    ];
    for (const withheld of withheldGrants) {
      expect(runner.has(withheld), `runner holds ${withheld}`).toBe(false);
    }
    // No core mutation at all: a runner starts what someone else authored.
    expect(coreGrants("runner").filter((p) => p.endsWith(":write"))).toEqual([]);
  });

  it("carries the module contributions that named it, and no others", () => {
    // The friendly surfaces a non-builder uses — every write behind them is
    // gated by the principal's own permissions, so they grant nothing the
    // preset withholds. `webhooks` names admin/builder only and must stay out.
    // Read as strings: `chat:*` is contributed by `@appstrate/module-chat`,
    // a workspace whose `ModuleResources` declaration merge does not reach this
    // project, so it is absent from `Permission` here while present in the set.
    const runner: ReadonlySet<string> = presetPermissions("runner");
    for (const held of ["chat:read", "chat:write", "mcp:read", "mcp:invoke"]) {
      expect(runner.has(held), `runner holds ${held}`).toBe(true);
    }
    for (const withheld of ["webhooks:read", "webhooks:write"]) {
      expect(runner.has(withheld), `runner holds ${withheld}`).toBe(false);
    }
  });

  it("is what an explicit member holding it reaches, org half included", () => {
    // Through the resolver, not the matrix: an org `member` added as `runner`
    // in a closed space keeps the org reads and gains nothing else.
    const ref = resolveSpaceRole(
      "member",
      { id: "spc_test", visibility: "closed", defaultRole: "operator" },
      { ref: { kind: "preset", preset: "runner" } },
    );
    const effective = effectivePermissions({
      orgPermissions: orgPermissions("member"),
      spacePermissions: spacePermissions(ref),
    });
    expect(effective.has("agents:run")).toBe(true);
    expect(effective.has("agents:read")).toBe(false);
    expect(effective.has("org:read")).toBe(true);
  });
});
describe("runs:read-all", () => {
  it("is held by builder and admin, and by neither operator nor viewer", () => {
    // `read` is the runs the principal launched; `read-all` is the space-wide
    // supervision view. `admin`/`builder` derive it from the catalog — the
    // point of asserting it here is that the derivation reaches them and the
    // two narrower presets, which enumerate their grants by hand, stay out.
    for (const preset of ["admin", "builder"] as const) {
      expect(presetPermissions(preset).has("runs:read-all"), preset).toBe(true);
    }
    for (const preset of ["operator", "viewer"] as const) {
      expect(presetPermissions(preset).has("runs:read-all"), preset).toBe(false);
      // …while plain `runs:read` is unchanged for the operator.
      expect(presetPermissions(preset).has("runs:read"), preset).toBe(true);
    }
  });

  it("is API-key grantable, and only to a creator who holds it", () => {
    expect(API_KEY_ALLOWED_SCOPES.has("runs:read-all")).toBe(true);
    // An org admin holds the `admin` preset in the default space.
    expect(validateScopes(["runs:read", "runs:read-all"], inDefaultSpace("admin"))).toEqual([
      "runs:read",
      "runs:read-all",
    ]);
    // A plain member holds `operator` there: the wider scope narrows away
    // silently, exactly like any other grant above the creator.
    expect(validateScopes(["runs:read", "runs:read-all"], inDefaultSpace("member"))).toEqual([
      "runs:read",
    ]);
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
    // (the webhooks, oidc and ee modules respectively). `apiKeyGrantable`
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
