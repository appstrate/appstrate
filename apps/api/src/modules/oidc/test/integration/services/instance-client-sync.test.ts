// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for declarative provisioning of instance-level OAuth
 * clients via `OIDC_INSTANCE_CLIENTS`.
 *
 * Covers the full sync policy: create, idempotence, drift (redirect URIs
 * and secret rotation), orphan warning, cross-level collision, validation
 * errors, and the orphan whitelist for the auto-provisioned platform
 * client.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { _resetCacheForTesting } from "@appstrate/env";
import { db } from "@appstrate/db/client";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { oauthClient } from "@appstrate/db/schema";
import {
  syncInstanceClientsFromEnv,
  InstanceClientSyncError,
} from "../../../services/instance-client-sync.ts";
import { hashSecret, ensureInstanceClient } from "../../../services/oauth-admin.ts";

const VALID_SECRET = "abcd1234".repeat(4); // 32 chars

const ORIGINAL_ENV = process.env.OIDC_INSTANCE_CLIENTS;

function setDeclaration(value: unknown): void {
  process.env.OIDC_INSTANCE_CLIENTS = JSON.stringify(value);
  _resetCacheForTesting();
}

function clearDeclaration(): void {
  delete process.env.OIDC_INSTANCE_CLIENTS;
  _resetCacheForTesting();
}

function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientId: "admin-dashboard",
    clientSecret: VALID_SECRET,
    name: "Admin Dashboard",
    redirectUris: ["https://admin.example.com/auth/callback"],
    postLogoutRedirectUris: ["https://admin.example.com"],
    scopes: ["openid", "profile", "email", "offline_access"],
    skipConsent: false,
    ...overrides,
  };
}

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.OIDC_INSTANCE_CLIENTS;
  } else {
    process.env.OIDC_INSTANCE_CLIENTS = ORIGINAL_ENV;
  }
  _resetCacheForTesting();
});

// ─── Create path ──────────────────────────────────────────────────────────────

describe("syncInstanceClientsFromEnv — create", () => {
  it("creates a declared client when DB is empty", async () => {
    setDeclaration([validEntry()]);
    await syncInstanceClientsFromEnv();

    const [row] = await db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, "admin-dashboard"))
      .limit(1);
    expect(row).toBeDefined();
    expect(row!.level).toBe("instance");
    expect(row!.name).toBe("Admin Dashboard");
    expect(row!.redirectUris).toEqual(["https://admin.example.com/auth/callback"]);
    expect(row!.postLogoutRedirectUris).toEqual(["https://admin.example.com"]);
    expect(row!.scopes).toEqual(["openid", "profile", "email", "offline_access"]);
    expect(row!.skipConsent).toBe(false);
    expect(row!.type).toBe("web");
    expect(row!.tokenEndpointAuthMethod).toBe("client_secret_basic");
    expect(row!.requirePKCE).toBe(true);
    expect(row!.referencedOrgId).toBeNull();
    expect(row!.referencedSpaceId).toBeNull();
    expect(row!.allowSignup).toBe(false);
  });

  it("stores the secret hashed, never plaintext", async () => {
    setDeclaration([validEntry()]);
    await syncInstanceClientsFromEnv();

    const [row] = await db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, "admin-dashboard"))
      .limit(1);
    expect(row!.clientSecret).not.toBe(VALID_SECRET);
    expect(row!.clientSecret).toBe(await hashSecret(VALID_SECRET));
  });

  it("persists metadata with { level, clientId } shape", async () => {
    setDeclaration([validEntry()]);
    await syncInstanceClientsFromEnv();

    const [row] = await db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, "admin-dashboard"))
      .limit(1);
    const metadata = JSON.parse(row!.metadata ?? "{}");
    expect(metadata.level).toBe("instance");
    expect(metadata.clientId).toBe("admin-dashboard");
  });

  it("creates multiple declared clients in one pass", async () => {
    setDeclaration([
      validEntry({ clientId: "admin-a", name: "A" }),
      validEntry({ clientId: "admin-b", name: "B" }),
    ]);
    await syncInstanceClientsFromEnv();

    const rows = await db.select().from(oauthClient).where(eq(oauthClient.level, "instance"));
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(["A", "B"]);
  });

  it("no-op on empty declaration", async () => {
    setDeclaration([]);
    await syncInstanceClientsFromEnv();

    const rows = await db.select().from(oauthClient);
    expect(rows).toHaveLength(0);
  });
});

// ─── Idempotence ──────────────────────────────────────────────────────────────

describe("syncInstanceClientsFromEnv — idempotence", () => {
  it("is a no-op when declaration is unchanged", async () => {
    setDeclaration([validEntry()]);
    await syncInstanceClientsFromEnv();
    const firstRows = await db.select().from(oauthClient);
    await syncInstanceClientsFromEnv();
    const secondRows = await db.select().from(oauthClient);
    expect(secondRows).toHaveLength(firstRows.length);
  });
});

// ─── Drift detection ──────────────────────────────────────────────────────────

describe("syncInstanceClientsFromEnv — drift", () => {
  it("fails when redirectUris change", async () => {
    setDeclaration([validEntry()]);
    await syncInstanceClientsFromEnv();

    setDeclaration([
      validEntry({
        redirectUris: [
          "https://admin.example.com/auth/callback",
          "https://admin.example.com/auth/cb2",
        ],
      }),
    ]);
    let caught: unknown;
    try {
      await syncInstanceClientsFromEnv();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InstanceClientSyncError);
    expect((caught as Error).message).toContain("drift");
    expect((caught as Error).message).toContain("redirectUris");
  });

  it("fails when postLogoutRedirectUris change", async () => {
    setDeclaration([validEntry()]);
    await syncInstanceClientsFromEnv();

    setDeclaration([validEntry({ postLogoutRedirectUris: ["https://admin.example.com/other"] })]);
    await expect(syncInstanceClientsFromEnv()).rejects.toThrow(/postLogoutRedirectUris/);
  });

  it("fails when scopes change", async () => {
    setDeclaration([validEntry()]);
    await syncInstanceClientsFromEnv();

    setDeclaration([validEntry({ scopes: ["openid", "profile"] })]);
    await expect(syncInstanceClientsFromEnv()).rejects.toThrow(/scopes/);
  });

  it("fails when the secret is rotated in the env", async () => {
    setDeclaration([validEntry()]);
    await syncInstanceClientsFromEnv();

    setDeclaration([validEntry({ clientSecret: "differentSecretWith32Chars__xxxx" })]);
    await expect(syncInstanceClientsFromEnv()).rejects.toThrow(/clientSecret/);
  });

  it("fails when name changes", async () => {
    setDeclaration([validEntry()]);
    await syncInstanceClientsFromEnv();

    setDeclaration([validEntry({ name: "Renamed" })]);
    await expect(syncInstanceClientsFromEnv()).rejects.toThrow(/name/);
  });

  it("does not drift when the stored scope set is only reordered", async () => {
    setDeclaration([validEntry({ scopes: ["openid", "profile", "files:read"] })]);
    await syncInstanceClientsFromEnv();

    await db
      .update(oauthClient)
      .set({ scopes: ["files:read", "openid", "profile"] })
      .where(eq(oauthClient.clientId, "admin-dashboard"));

    await syncInstanceClientsFromEnv(); // Must not throw — the compare is set-based.

    const [row] = await db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, "admin-dashboard"))
      .limit(1);
    // Unchanged — a match is a no-op, the sync never rewrites the row.
    expect(row!.scopes).toEqual(["files:read", "openid", "profile"]);
  });

  it("reports a scope drift when the sets differ", async () => {
    setDeclaration([validEntry({ scopes: ["openid", "profile", "files:read"] })]);
    await syncInstanceClientsFromEnv();

    await db
      .update(oauthClient)
      .set({ scopes: ["openid", "profile", "files:delete"] })
      .where(eq(oauthClient.clientId, "admin-dashboard"));

    await expect(syncInstanceClientsFromEnv()).rejects.toThrow(/scopes/);
  });

  // A scope string that a data migration rewrote (`documents:*` -> `files:*`,
  // `applications:*` -> `spaces:*`) used to get its own diagnostic naming the
  // rename. That branch was retirement machinery and went with the transition
  // (`docs/NO_TRANSITIONAL_CODE.md` §4): the retired spelling is now an unknown
  // scope like any other, and an operator whose env still names it gets the
  // ordinary drift path. These pin that it is REFUSED — the property that
  // matters — and that no rename vocabulary survives anywhere in the message.
  for (const retired of ["documents:read", "applications:read"]) {
    it(`refuses the retired spelling ${retired} as an unknown scope, naming no rename`, async () => {
      setDeclaration([validEntry({ scopes: ["openid", "profile", "files:read"] })]);
      await syncInstanceClientsFromEnv();

      setDeclaration([validEntry({ scopes: ["openid", "profile", retired] })]);
      let caught: unknown;
      try {
        await syncInstanceClientsFromEnv();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(InstanceClientSyncError);
      const message = (caught as Error).message;
      expect(message).toContain("OIDC_INSTANCE_CLIENTS");
      // No rename vocabulary survives: the platform does not know these were
      // renamed, only that they are not scopes.
      expect(message).not.toContain("renamed");
      expect(message).not.toContain("-> files:read");
      expect(message).not.toContain("-> spaces:read");
      // But the DESTRUCTIVE remedy must still be withheld — not because the
      // spelling is retired, because the declaration would not survive its own
      // re-create. Deleting the row would lose every satellite session AND
      // still not boot.
      expect(message).not.toContain("DELETE FROM oauth_clients");
      expect(message).toContain("outside the OIDC vocabulary");
      expect(message).toContain("Do NOT delete the oauth_clients row");
    });
  }

  it("withholds the delete remedy for ANY unusable scope, not just a renamed one", async () => {
    // The property is "would this declaration survive a re-create?", so a plain
    // typo gets the same protection. Without this the guard reads as if it were
    // still about retired spellings.
    setDeclaration([validEntry({ scopes: ["openid", "profile", "files:read"] })]);
    await syncInstanceClientsFromEnv();

    setDeclaration([validEntry({ scopes: ["openid", "profile", "flies:raed"] })]);
    let caught: unknown;
    try {
      await syncInstanceClientsFromEnv();
    } catch (e) {
      caught = e;
    }
    const message = (caught as Error).message;
    expect(message).toContain("flies:raed");
    expect(message).not.toContain("DELETE FROM oauth_clients");
  });

  // Control: a drift whose declaration WOULD survive a re-create still gets the
  // generic remedy. This is the discriminator — without it, the assertions
  // above would pass just as well against a build that had stopped offering the
  // delete remedy at all.
  it("offers the delete remedy for a scope drift the declaration survives", async () => {
    setDeclaration([validEntry({ scopes: ["openid", "profile", "files:read"] })]);
    await syncInstanceClientsFromEnv();

    setDeclaration([validEntry({ scopes: ["openid", "profile"] })]);
    let caught: unknown;
    try {
      await syncInstanceClientsFromEnv();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InstanceClientSyncError);
    expect((caught as Error).message).toContain("DELETE FROM oauth_clients");
  });

  it("refuses a retired spelling on the create path too", async () => {
    setDeclaration([validEntry({ scopes: ["openid", "profile", "documents:read"] })]);
    let caught: unknown;
    try {
      await syncInstanceClientsFromEnv();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InstanceClientSyncError);
    expect((caught as Error).message).toContain("scopes");
  });

  it("treats redirectUris as order-insensitive (no drift on reorder)", async () => {
    setDeclaration([
      validEntry({
        redirectUris: ["https://a.example.com/cb", "https://b.example.com/cb"],
      }),
    ]);
    await syncInstanceClientsFromEnv();

    setDeclaration([
      validEntry({
        redirectUris: ["https://b.example.com/cb", "https://a.example.com/cb"],
      }),
    ]);
    await syncInstanceClientsFromEnv(); // Should not throw.
  });
});

// ─── Orphan handling ──────────────────────────────────────────────────────────

describe("syncInstanceClientsFromEnv — orphans", () => {
  it("does NOT delete a client removed from the declaration", async () => {
    setDeclaration([validEntry()]);
    await syncInstanceClientsFromEnv();

    setDeclaration([]);
    await syncInstanceClientsFromEnv(); // Should not throw.

    const [row] = await db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, "admin-dashboard"))
      .limit(1);
    expect(row).toBeDefined(); // Still there.
  });

  it("whitelists the auto-provisioned platform client from orphan warnings", async () => {
    await ensureInstanceClient("http://localhost:3000");
    setDeclaration([]);
    // Should complete without throwing — the platform client is ignored.
    await syncInstanceClientsFromEnv();

    const rows = await db.select().from(oauthClient).where(eq(oauthClient.level, "instance"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clientId).toStartWith("oauth_");
  });

  it("coexists with the platform client when env declares satellite clients", async () => {
    await ensureInstanceClient("http://localhost:3000");
    setDeclaration([validEntry()]);
    await syncInstanceClientsFromEnv();

    const rows = await db.select().from(oauthClient).where(eq(oauthClient.level, "instance"));
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.clientId).sort();
    expect(ids.some((id) => id.startsWith("oauth_"))).toBe(true);
    expect(ids).toContain("admin-dashboard");
  });
});

// ─── Cross-level collision ────────────────────────────────────────────────────

describe("syncInstanceClientsFromEnv — collision", () => {
  it("refuses to operate when a non-instance client already owns the clientId", async () => {
    // Directly insert a fake org-level row with clientId "admin-dashboard".
    // We cannot use createClient() because it generates a random clientId.
    const { createClient } = await import("../../../services/oauth-admin.ts");
    // Create a real org first so the FK passes — we cheat by using Drizzle
    // directly to force a collision on clientId.
    // Simpler: create any org client then update its clientId column by hand.
    const { createTestUser, createTestOrg } =
      await import("../../../../../../test/helpers/auth.ts");
    const { id: ownerId } = await createTestUser();
    const { org } = await createTestOrg(ownerId, { slug: "collisionorg" });
    const orgClient = await createClient({
      level: "org",
      name: "Existing Org Client",
      redirectUris: ["https://example.com/cb"],
      referencedOrgId: org.id,
    });
    // Overwrite the randomly generated clientId to force a collision.
    await db
      .update(oauthClient)
      .set({ clientId: "admin-dashboard" })
      .where(eq(oauthClient.clientId, orgClient.clientId));

    setDeclaration([validEntry()]);
    let caught: unknown;
    try {
      await syncInstanceClientsFromEnv();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InstanceClientSyncError);
    expect((caught as Error).message).toContain("collides");
    expect((caught as Error).message).toContain("org");
  });
});

// ─── Validation errors ────────────────────────────────────────────────────────

describe("syncInstanceClientsFromEnv — validation", () => {
  it("rejects duplicate clientIds in the declaration", async () => {
    setDeclaration([validEntry(), validEntry()]);
    let caught: unknown;
    try {
      await syncInstanceClientsFromEnv();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InstanceClientSyncError);
    expect((caught as Error).message).toContain("duplicate");
  });

  it("rejects short secrets (< 32 chars)", async () => {
    setDeclaration([validEntry({ clientSecret: "tooshort" })]);
    await expect(syncInstanceClientsFromEnv()).rejects.toThrow(/clientSecret/);
  });

  it("rejects clientIds with the reserved oauth_ prefix", async () => {
    setDeclaration([validEntry({ clientId: "oauth_admin" })]);
    await expect(syncInstanceClientsFromEnv()).rejects.toThrow(/oauth_/);
  });

  it("rejects clientIds with invalid characters", async () => {
    setDeclaration([validEntry({ clientId: "admin dashboard" })]);
    await expect(syncInstanceClientsFromEnv()).rejects.toThrow();
  });

  it("rejects missing required fields", async () => {
    const broken = { clientId: "foo", clientSecret: VALID_SECRET };
    setDeclaration([broken]);
    await expect(syncInstanceClientsFromEnv()).rejects.toThrow();
  });

  it("rejects disallowed redirect URI schemes", async () => {
    setDeclaration([validEntry({ redirectUris: ["javascript:alert(1)"] })]);
    await expect(syncInstanceClientsFromEnv()).rejects.toThrow();
  });
});

// ─── Empty / unset env ────────────────────────────────────────────────────────

describe("syncInstanceClientsFromEnv — env absent", () => {
  it("is a no-op when OIDC_INSTANCE_CLIENTS is unset", async () => {
    clearDeclaration();
    await syncInstanceClientsFromEnv();
    const rows = await db.select().from(oauthClient);
    expect(rows).toHaveLength(0);
  });
});

// ─── oidcModule.init() wiring ─────────────────────────────────────────────────
//
// End-to-end coverage for the boot path: invoking `oidcModule.init()` with
// a realistic `ModuleInitContext` must (a) run `ensureInstanceClient` for
// the platform SPA and (b) reconcile `OIDC_INSTANCE_CLIENTS`.
// This is the only test that proves the module's `init` hook actually
// drives the sync — `getTestApp()` only wires `createRouter()`.

describe("oidcModule.init() — boot wiring", () => {
  it("runs syncInstanceClientsFromEnv when the module initializes", async () => {
    setDeclaration([validEntry({ clientId: "wired-admin", name: "Wired Admin" })]);

    const { default: oidcModule } = await import("../../../index.ts");
    const initCtx = {
      redisUrl: process.env.REDIS_URL ?? null,
      appUrl: process.env.APP_URL ?? "http://localhost:3000",
      // Migrations are already applied by the test preload — we only care
      // about the post-migration steps of `init()` here.
      getSendMail: async () => () => {},
      getOrgAdminEmails: async () => [],
      getOrgName: async () => null,
      services: {} as import("@appstrate/core/module").PlatformServices,
    };

    await oidcModule.init!(initCtx);

    // The platform auto-provisioned client (oauth_-prefixed) AND the
    // env-declared client must both exist after init.
    const instanceRows = await db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.level, "instance"));
    const ids = instanceRows.map((r) => r.clientId).sort();

    expect(ids).toContain("wired-admin");
    expect(ids.some((id) => id.startsWith("oauth_"))).toBe(true);

    // And the env-provisioned client carries the full metadata set.
    const [wired] = await db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, "wired-admin"))
      .limit(1);
    expect(wired).toBeDefined();
    expect(wired!.name).toBe("Wired Admin");
    expect(wired!.redirectUris).toEqual(["https://admin.example.com/auth/callback"]);
    expect(wired!.requirePKCE).toBe(true);
  });

  it("aborts init when the declared env is invalid JSON schema", async () => {
    setDeclaration([{ clientId: "oauth_forbidden_prefix", clientSecret: VALID_SECRET }]);

    const { default: oidcModule } = await import("../../../index.ts");
    const initCtx = {
      redisUrl: process.env.REDIS_URL ?? null,
      appUrl: process.env.APP_URL ?? "http://localhost:3000",
      getSendMail: async () => () => {},
      getOrgAdminEmails: async () => [],
      getOrgName: async () => null,
      services: {} as import("@appstrate/core/module").PlatformServices,
    };

    let caught: unknown;
    try {
      await oidcModule.init!(initCtx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InstanceClientSyncError);
  });
});
