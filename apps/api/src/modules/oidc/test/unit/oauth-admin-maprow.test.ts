// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the resilient row mapper (`mapRowSafe`) and its level
 * type guard. Verifies that a corrupted `level` value in a single row
 * cannot crash the entire listing pipeline — the row is skipped with a
 * warning log, and the rest of the list is still returned.
 */

import { describe, it, expect, spyOn } from "bun:test";
import { isKnownLevel, mapRowSafe } from "../../services/oauth-admin.ts";
import { logger } from "../../../../lib/logger.ts";
import type { oauthClient } from "../../schema.ts";

type Row = typeof oauthClient.$inferSelect;

function baseRow(overrides: Partial<Row>): Row {
  // Minimal shape the mapper reads — unrelated columns can be undefined
  // since Drizzle types them nullable.
  return {
    id: "oac_1",
    clientId: "oauth_abc",
    name: "Test",
    level: "org",
    referencedOrgId: "org_1",
    referencedApplicationId: null,
    redirectUris: ["https://app.example/cb"],
    postLogoutRedirectUris: [],
    scopes: ["openid"],
    disabled: false,
    skipConsent: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    metadata: null,
    clientSecret: "deadbeef",
    type: "web",
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    requirePKCE: true,
    ...overrides,
  } as unknown as Row;
}

describe("isKnownLevel", () => {
  it("accepts the three valid levels", () => {
    expect(isKnownLevel("instance")).toBe(true);
    expect(isKnownLevel("org")).toBe(true);
    expect(isKnownLevel("application")).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(isKnownLevel("tenant")).toBe(false);
    expect(isKnownLevel("")).toBe(false);
    expect(isKnownLevel(null)).toBe(false);
    expect(isKnownLevel(undefined)).toBe(false);
    expect(isKnownLevel(42)).toBe(false);
  });
});

describe("mapRowSafe", () => {
  it("maps a valid org row", () => {
    const row = baseRow({ level: "org", referencedOrgId: "org_42" });
    const mapped = mapRowSafe(row);
    expect(mapped).not.toBeNull();
    expect(mapped!.level).toBe("org");
    expect(mapped!.referencedOrgId).toBe("org_42");
  });

  it("returns null and logs a warning for an unknown level instead of throwing", () => {
    // This is the core regression test: previously `mapRow` threw on an
    // unexpected level, which crashed any listing that contained even one
    // corrupted row and locked admins out of the OAuth clients page.
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const row = baseRow({ level: "tenant" as unknown as "org" });
      const mapped = mapRowSafe(row);
      expect(mapped).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const meta = warnSpy.mock.calls[0]![1] as Record<string, unknown>;
      expect(meta).toMatchObject({
        module: "oidc",
        clientId: "oauth_abc",
        level: "tenant",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("handles a row with all three valid levels symmetrically", () => {
    for (const level of ["instance", "org", "application"] as const) {
      const row = baseRow({
        level,
        referencedOrgId: level === "org" ? "org_1" : null,
        referencedApplicationId: level === "application" ? "app_1" : null,
      });
      expect(mapRowSafe(row)?.level).toBe(level);
    }
  });
});
