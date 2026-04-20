// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, spyOn, afterEach } from "bun:test";
import { scopesToPermissions } from "../../auth/claims.ts";
import { logger } from "../../../../lib/logger.ts";
import { resolvePermissions } from "../../../../lib/permissions.ts";
import { OIDC_ALLOWED_SCOPES } from "../../auth/scopes.ts";
import {
  setModulePermissionsProvider,
  type ModulePermissionsSnapshot,
} from "@appstrate/core/permissions";

describe("scopesToPermissions — end_user flow", () => {
  it("returns an empty set for undefined / empty scope", () => {
    expect(scopesToPermissions(undefined, "end_user").size).toBe(0);
    expect(scopesToPermissions("", "end_user").size).toBe(0);
    expect(scopesToPermissions("   ", "end_user").size).toBe(0);
  });

  it("drops identity-only scopes", () => {
    expect(scopesToPermissions("openid profile email offline_access", "end_user").size).toBe(0);
  });

  it("passes through a single allowed core permission verbatim", () => {
    const perms = scopesToPermissions("runs:read", "end_user");
    expect([...perms]).toEqual(["runs:read"]);
  });

  it("drops destructive permissions not in OIDC_ALLOWED_SCOPES", () => {
    // Scope drops are logged at `debug` (not `warn`) — scope downgrade is
    // normal RFC 6749 behavior that fires per token mint, not an anomaly.
    const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      const perms = scopesToPermissions(
        "openid runs:read agents:delete webhooks:write",
        "end_user",
      );
      expect([...perms]).toEqual(["runs:read"]);
      expect(debugSpy).toHaveBeenCalledTimes(2);
    } finally {
      debugSpy.mockRestore();
    }
  });

  it("drops unknown scopes with debug log carrying module + scope metadata", () => {
    const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      scopesToPermissions("mystery:scope", "end_user");
      expect(debugSpy).toHaveBeenCalledTimes(1);
      const call = debugSpy.mock.calls[0]!;
      const meta = call[1] as Record<string, unknown>;
      expect(meta).toMatchObject({ module: "oidc", scope: "mystery:scope" });
    } finally {
      debugSpy.mockRestore();
    }
  });

  it("every OIDC_ALLOWED_SCOPES entry is a real core permission", () => {
    const memberPerms = resolvePermissions("member");
    for (const scope of OIDC_ALLOWED_SCOPES) {
      expect(memberPerms.has(scope)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Module-contributed `endUserGrantable` propagation
//
// Regression coverage for the RBAC extension point: a module that opts
// in to `endUserGrantable: true` on one of its resources MUST see that
// resource accepted on end-user JWTs, while a sibling resource without
// the opt-in MUST be dropped even if it is otherwise a valid grant.
//
// The unit layer is sufficient — `scopesToPermissions` is the single
// policy node between a JWT scope string and the `c.get("permissions")`
// Set that every guard reads. We inject a synthetic module snapshot
// via `setModulePermissionsProvider`, call the filter, and assert the
// end-user-allowed set reaches the granted Set; the integration
// pipeline (JWT parse → strategy → auth-pipeline → guard) is already
// covered by existing OIDC strategy tests for the in-tree OIDC scope
// surface and adds no new branches for this extension.
// ---------------------------------------------------------------------------

function installSnapshot(snapshot: Partial<ModulePermissionsSnapshot>): void {
  const full: ModulePermissionsSnapshot = {
    byRole: {
      owner: new Set(),
      admin: new Set(),
      member: new Set(),
      viewer: new Set(),
      ...(snapshot.byRole ?? {}),
    },
    apiKeyAllowed: snapshot.apiKeyAllowed ?? new Set(),
    endUserAllowed: snapshot.endUserAllowed ?? new Set(),
  };
  setModulePermissionsProvider(() => full);
}

describe("scopesToPermissions — module endUserGrantable propagation", () => {
  afterEach(() => {
    // Belt on top of the global preload reset — makes the per-test
    // isolation intent explicit at the test level and keeps this suite
    // runnable in isolation (`bun test scopes-to-permissions.test.ts`)
    // without leaking state to a subsequent manual run.
    setModulePermissionsProvider(null);
  });

  it("end-user token carrying a module scope opted in via endUserGrantable is granted", () => {
    installSnapshot({ endUserAllowed: new Set(["chat:read"]) });
    const perms = scopesToPermissions("openid chat:read", "end_user");
    expect([...perms]).toEqual(["chat:read"]);
  });

  it("module scope without endUserGrantable is dropped on end-user tokens", () => {
    // `chat:write` is contributed but NOT opted in for end-users → the
    // filter must strip it even if the JWT advertises it.
    installSnapshot({ endUserAllowed: new Set(["chat:read"]) });
    const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      const perms = scopesToPermissions("chat:read chat:write", "end_user");
      expect([...perms]).toEqual(["chat:read"]);
      // The dropped scope logs at debug with the standard metadata shape
      // — regression guard on the audit trail for silent drops.
      const dropped = debugSpy.mock.calls.find(
        (call) => (call[1] as Record<string, unknown>)?.scope === "chat:write",
      );
      expect(dropped).toBeDefined();
    } finally {
      debugSpy.mockRestore();
    }
  });

  it("module scope opted in for end-users coexists with core OIDC_ALLOWED_SCOPES", () => {
    installSnapshot({ endUserAllowed: new Set(["chat:read", "notifications:read"]) });
    const perms = scopesToPermissions(
      "openid runs:read chat:read notifications:read agents:write",
      "end_user",
    );
    // `runs:read` is in core OIDC_ALLOWED_SCOPES, the two module scopes
    // come from endUserAllowed, and `agents:write` is neither → dropped.
    expect([...perms].sort()).toEqual(["chat:read", "notifications:read", "runs:read"]);
  });

  it("OSS baseline (empty provider) preserves the pre-module filter behavior", () => {
    installSnapshot({}); // endUserAllowed defaults to empty
    const perms = scopesToPermissions("chat:read runs:read", "end_user");
    // Only core OIDC_ALLOWED_SCOPES survives.
    expect([...perms]).toEqual(["runs:read"]);
  });

  it("end-user module scope does NOT bypass the dashboard role ceiling", () => {
    // Regression guard: the endUserAllowed Set is consulted only on the
    // `end_user` branch of `scopesToPermissions`. A scope not in the
    // dashboard user's role set must stay dropped on dashboard tokens,
    // even when the module has opted the scope in for end-users.
    installSnapshot({ endUserAllowed: new Set(["chat:read"]) });
    const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      const perms = scopesToPermissions("chat:read", "dashboard_user", "member");
      expect(perms.size).toBe(0);
    } finally {
      debugSpy.mockRestore();
    }
  });
});

describe("scopesToPermissions — dashboard flow", () => {
  it("owner gets every scope in their token", () => {
    // Uses only core scopes — `oauth-clients:*` is now module-contributed
    // (owned by this very module via `permissionsContribution()`), so
    // asserting it here would require loading the OIDC module into the
    // permissions snapshot, which this unit test deliberately avoids. The
    // ceiling mechanic being verified (dashboard scope → role permissions)
    // is orthogonal to which resource is on the scope.
    const perms = scopesToPermissions(
      "openid agents:read agents:write runs:delete models:write",
      "dashboard_user",
      "owner",
    );
    expect(perms.has("agents:read")).toBe(true);
    expect(perms.has("agents:write")).toBe(true);
    expect(perms.has("runs:delete")).toBe(true);
    expect(perms.has("models:write")).toBe(true);
  });

  it("admin gets everything except owner-only perms (via role ceiling)", () => {
    const perms = scopesToPermissions("org:delete agents:read", "dashboard_user", "admin");
    expect(perms.has("org:delete")).toBe(false);
    expect(perms.has("agents:read")).toBe(true);
  });

  it("member is filtered to the role's permission set — escalation blocked", () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const perms = scopesToPermissions(
        "agents:read agents:delete oauth-clients:write",
        "dashboard_user",
        "member",
      );
      expect(perms.has("agents:read")).toBe(true);
      expect(perms.has("agents:delete")).toBe(false);
      expect(perms.has("oauth-clients:write")).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("dashboard without orgRole drops every non-identity scope", () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const perms = scopesToPermissions("agents:read", "dashboard_user");
      expect(perms.size).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("scopesToPermissions — narrowing guards", () => {
  it("arbitrary non-Permission strings never end up in the granted set", () => {
    // Regression test for the type-widening concern: the previous
    // implementation cast the allowed-scope set to `ReadonlySet<string>`
    // and used `granted.add(s as Permission)`, which would technically
    // accept any string that somehow passed `.has()`. With the typed
    // predicate in place, unknown strings are dropped at runtime.
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const perms = scopesToPermissions(
        "runs:read totally-fake evil:injection 🚀 agents:run",
        "end_user",
      );
      // Only the two real OIDC-allowed core permissions survive.
      expect([...perms].sort()).toEqual(["agents:run", "runs:read"]);
      // Every survivor is exercise-able through Permission's type contract.
      for (const p of perms) {
        expect(typeof p).toBe("string");
        expect(p.includes(":")).toBe(true);
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("dashboard ceiling narrowing rejects scopes missing from the role set", () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const perms = scopesToPermissions(
        "agents:read not:a:permission billing:manage",
        "dashboard_user",
        "member",
      );
      // `agents:read` is in MEMBER_PERMISSIONS; the other two are not.
      expect(perms.has("agents:read")).toBe(true);
      expect(perms.size).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
