// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, spyOn } from "bun:test";
import { scopesToPermissions } from "../../auth/claims.ts";
import { logger } from "../../../../lib/logger.ts";

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

  it("drops unknown scopes but keeps known ones", () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const perms = scopesToPermissions("runs totally:unknown other:scope");
      expect([...perms]).toEqual(["runs:read"]);
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warn-logs unknown scopes with module+scope metadata for operator visibility", () => {
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
    const perms = scopesToPermissions("runs\tagents");
    expect([...perms].sort()).toEqual(["agents:read", "runs:read"]);
  });
});
