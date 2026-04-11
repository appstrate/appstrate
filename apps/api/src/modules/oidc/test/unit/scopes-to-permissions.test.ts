// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, spyOn } from "bun:test";
import { scopesToPermissions } from "../../auth/claims.ts";
import { logger } from "../../../../lib/logger.ts";
import { OIDC_ALLOWED_SCOPES, resolvePermissions } from "../../../../lib/permissions.ts";

describe("scopesToPermissions", () => {
  it("returns an empty set for undefined / empty scope", () => {
    expect(scopesToPermissions(undefined).size).toBe(0);
    expect(scopesToPermissions("").size).toBe(0);
    expect(scopesToPermissions("   ").size).toBe(0);
  });

  it("drops identity-only scopes (openid profile email offline_access)", () => {
    expect(scopesToPermissions("openid profile email offline_access").size).toBe(0);
  });

  it("passes through a single allowed core permission verbatim", () => {
    const perms = scopesToPermissions("runs:read");
    expect([...perms]).toEqual(["runs:read"]);
  });

  it("passes through multiple allowed core permissions", () => {
    const perms = scopesToPermissions("agents:run runs:read");
    expect([...perms].sort()).toEqual(["agents:run", "runs:read"]);
  });

  it("strips identity scopes and keeps allowed core permissions in the same call", () => {
    const perms = scopesToPermissions("openid profile agents:run runs:read");
    expect([...perms].sort()).toEqual(["agents:run", "runs:read"]);
  });

  it("drops destructive permissions that are not in OIDC_ALLOWED_SCOPES", () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const perms = scopesToPermissions("openid runs:read agents:delete webhooks:write");
      expect([...perms]).toEqual(["runs:read"]);
      // Two non-identity, non-allowed scopes → two warn calls.
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("drops unknown scopes with warn log carrying module + scope metadata", () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      scopesToPermissions("mystery:scope");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const call = warnSpy.mock.calls[0]!;
      const meta = call[1] as Record<string, unknown>;
      expect(meta).toMatchObject({ module: "oidc", scope: "mystery:scope" });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("splits on any whitespace, not just single spaces", () => {
    const perms = scopesToPermissions("agents:run\truns:read");
    expect([...perms].sort()).toEqual(["agents:run", "runs:read"]);
  });

  it("every OIDC_ALLOWED_SCOPES entry is a real core permission", () => {
    // Regression guard: the allowlist must stay a subset of the actual core
    // Permission vocabulary — a member role already holds all of them by
    // design (see permissions.ts MEMBER_PERMISSIONS).
    const memberPerms = resolvePermissions("member");
    for (const scope of OIDC_ALLOWED_SCOPES) {
      expect(memberPerms.has(scope)).toBe(true);
    }
  });
});
