// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, spyOn } from "bun:test";
import { scopesToPermissions } from "../../auth/claims.ts";
import { logger } from "../../../../lib/logger.ts";
import { resolvePermissions } from "../../../../lib/permissions.ts";
import { OIDC_ALLOWED_SCOPES } from "../../auth/scopes.ts";

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
