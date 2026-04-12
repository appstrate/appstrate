// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, spyOn } from "bun:test";
import { scopesToPermissions } from "../../auth/claims.ts";
import { logger } from "../../../../lib/logger.ts";
import { OIDC_ALLOWED_SCOPES, resolvePermissions } from "../../../../lib/permissions.ts";

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
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const perms = scopesToPermissions(
        "openid runs:read agents:delete webhooks:write",
        "end_user",
      );
      expect([...perms]).toEqual(["runs:read"]);
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("drops unknown scopes with warn log carrying module + scope metadata", () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      scopesToPermissions("mystery:scope", "end_user");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const call = warnSpy.mock.calls[0]!;
      const meta = call[1] as Record<string, unknown>;
      expect(meta).toMatchObject({ module: "oidc", scope: "mystery:scope" });
    } finally {
      warnSpy.mockRestore();
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
    const perms = scopesToPermissions(
      "openid agents:read agents:write runs:delete oauth-clients:write",
      "dashboard_user",
      "owner",
    );
    expect(perms.has("agents:read")).toBe(true);
    expect(perms.has("agents:write")).toBe(true);
    expect(perms.has("runs:delete")).toBe(true);
    expect(perms.has("oauth-clients:write")).toBe(true);
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
