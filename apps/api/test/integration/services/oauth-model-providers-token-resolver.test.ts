// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 8 hardening — OAuth model providers token-resolver edge cases
 * (cf. SPEC §10).
 *
 * Covers the platform-side service that the sidecar's `/internal/oauth-token/*`
 * routes proxy to. The PROVIDER_TOKEN_URL host (claude.ai / auth.openai.com)
 * is intercepted via `globalThis.fetch` swap — the same pattern used by
 * `llm-proxy.test.ts` — so no real network call leaves the test process.
 *
 * Edge cases under test:
 *   - `invalid_grant` from the provider → connection flagged
 *     `needsReconnection=true` AND `OAUTH_REFRESH_REVOKED` raised
 *     (so the worker's structured-warn path triggers, cf. SPEC §6).
 *   - Connection already flagged → `OAUTH_CONNECTION_NEEDS_RECONNECTION`
 *     short-circuit (no provider call).
 *   - Missing `refresh_token` in stored credentials → flagged + structured
 *     `OAUTH_REFRESH_TOKEN_MISSING`.
 *   - Successful refresh rotates `access_token` + `refresh_token` + `expiresAt`
 *     in DB and returns the new token.
 *   - Network error (fetch throws) surfaces as a non-fatal Error with a
 *     descriptive message (no sidecar crash).
 *   - `resolveOAuthTokenForSidecar` returns the cached token when it's far
 *     from expiry (no refresh).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedConnectionProfile, seedProviderCredentials, seedPackage } from "../../helpers/seed.ts";
import { encryptCredentials, decryptCredentials } from "@appstrate/connect";
import { userProviderConnections, orgSystemProviderKeys } from "@appstrate/db/schema";
import {
  forceRefreshOAuthModelProviderToken,
  resolveOAuthTokenForSidecar,
} from "../../../src/services/oauth-model-providers/token-resolver.ts";
import { ApiError } from "../../../src/lib/errors.ts";

// ─── globalThis.fetch swap ───────────────────────────────────

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let originalFetch: typeof fetch;
function mockFetch(impl: FetchImpl): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
}
function restoreFetch(): void {
  if (originalFetch) globalThis.fetch = originalFetch;
}

afterAll(() => restoreFetch());

// ─── Seed helpers ────────────────────────────────────────────

const CLAUDE_PROVIDER = "@appstrate/provider-claude-code";

async function seedOAuthModelProviderConnection(opts: {
  orgId: string;
  applicationId: string;
  connectionProfileId: string;
  providerId: string;
  credentials: Record<string, unknown>;
  expiresAt?: Date | null;
  needsReconnection?: boolean;
  /** When true, also create the orgSystemProviderKeys row referencing this connection. */
  withSystemProviderKey?: boolean;
}): Promise<{ connectionId: string; systemProviderKeyId: string | null }> {
  // FK target: applicationProviderCredentials.providerId references packages.id
  await seedPackage({
    orgId: null,
    id: opts.providerId,
    type: "provider",
    source: "system",
  }).catch(() => {});
  const cred = await seedProviderCredentials({
    applicationId: opts.applicationId,
    providerId: opts.providerId,
  });
  const [connection] = await db
    .insert(userProviderConnections)
    .values({
      connectionProfileId: opts.connectionProfileId,
      providerId: opts.providerId,
      orgId: opts.orgId,
      providerCredentialId: cred.id,
      credentialsEncrypted: encryptCredentials(opts.credentials),
      expiresAt: opts.expiresAt ?? null,
      needsReconnection: opts.needsReconnection ?? false,
    })
    .returning();
  let systemProviderKeyId: string | null = null;
  if (opts.withSystemProviderKey) {
    const [row] = await db
      .insert(orgSystemProviderKeys)
      .values({
        orgId: opts.orgId,
        label: "Test Claude OAuth",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        authMode: "oauth",
        oauthConnectionId: connection!.id,
        providerPackageId: opts.providerId,
      })
      .returning();
    systemProviderKeyId = row!.id;
  }
  return { connectionId: connection!.id, systemProviderKeyId };
}

// ─── Tests ───────────────────────────────────────────────────

describe("OAuth model providers — token-resolver hardening", () => {
  let userId: string;
  let orgId: string;
  let applicationId: string;
  let connectionProfileId: string;

  beforeEach(async () => {
    await truncateAll();
    const user = await createTestUser();
    userId = user.id;
    const { org, defaultAppId } = await createTestOrg(userId, { slug: "testorg" });
    orgId = org.id;
    applicationId = defaultAppId;
    const profile = await seedConnectionProfile({ userId, name: "Default", isDefault: true });
    connectionProfileId = profile.id;
  });

  afterEach(() => restoreFetch());

  describe("forceRefreshOAuthModelProviderToken", () => {
    it("on invalid_grant: flags needsReconnection=true and throws OAUTH_REFRESH_REVOKED", async () => {
      const { connectionId } = await seedOAuthModelProviderConnection({
        orgId,
        applicationId,
        connectionProfileId,
        providerId: CLAUDE_PROVIDER,
        credentials: { access_token: "stale", refresh_token: "rt-revoked" },
        expiresAt: new Date(Date.now() - 10_000),
      });

      mockFetch(
        async () =>
          new Response(
            JSON.stringify({ error: "invalid_grant", error_description: "refresh token revoked" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          ),
      );

      let caught: unknown;
      try {
        await forceRefreshOAuthModelProviderToken(connectionId);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).code).toBe("OAUTH_REFRESH_REVOKED");
      expect((caught as ApiError).status).toBe(410);

      const [row] = await db
        .select({ needsReconnection: userProviderConnections.needsReconnection })
        .from(userProviderConnections)
        .where(eq(userProviderConnections.id, connectionId))
        .limit(1);
      expect(row?.needsReconnection).toBe(true);
    });

    it("on already-flagged connection: short-circuits with OAUTH_CONNECTION_NEEDS_RECONNECTION (no fetch)", async () => {
      const { connectionId } = await seedOAuthModelProviderConnection({
        orgId,
        applicationId,
        connectionProfileId,
        providerId: CLAUDE_PROVIDER,
        credentials: { access_token: "stale", refresh_token: "rt-1" },
        needsReconnection: true,
      });

      let fetchCalled = false;
      mockFetch(async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      });

      let caught: unknown;
      try {
        await forceRefreshOAuthModelProviderToken(connectionId);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).code).toBe("OAUTH_CONNECTION_NEEDS_RECONNECTION");
      expect(fetchCalled).toBe(false);
    });

    it("on missing refresh_token: flags needsReconnection and throws OAUTH_REFRESH_TOKEN_MISSING", async () => {
      const { connectionId } = await seedOAuthModelProviderConnection({
        orgId,
        applicationId,
        connectionProfileId,
        providerId: CLAUDE_PROVIDER,
        // No refresh_token in credentials
        credentials: { access_token: "only-access-token" },
      });

      let fetchCalled = false;
      mockFetch(async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      });

      let caught: unknown;
      try {
        await forceRefreshOAuthModelProviderToken(connectionId);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).code).toBe("OAUTH_REFRESH_TOKEN_MISSING");
      expect(fetchCalled).toBe(false);

      const [row] = await db
        .select({ needsReconnection: userProviderConnections.needsReconnection })
        .from(userProviderConnections)
        .where(eq(userProviderConnections.id, connectionId))
        .limit(1);
      expect(row?.needsReconnection).toBe(true);
    });

    it("on success: rotates access_token + refresh_token + expiresAt in DB", async () => {
      const { connectionId } = await seedOAuthModelProviderConnection({
        orgId,
        applicationId,
        connectionProfileId,
        providerId: CLAUDE_PROVIDER,
        credentials: { access_token: "old-access", refresh_token: "old-refresh" },
        expiresAt: new Date(Date.now() - 10_000),
      });

      mockFetch(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "new-access",
              refresh_token: "new-refresh",
              token_type: "Bearer",
              expires_in: 3600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );

      const result = await forceRefreshOAuthModelProviderToken(connectionId);
      expect(result.accessToken).toBe("new-access");
      expect(result.expiresAt).not.toBeNull();
      expect(result.expiresAt).toBeGreaterThan(Date.now());

      const [row] = await db
        .select({
          credentialsEncrypted: userProviderConnections.credentialsEncrypted,
          expiresAt: userProviderConnections.expiresAt,
          needsReconnection: userProviderConnections.needsReconnection,
        })
        .from(userProviderConnections)
        .where(eq(userProviderConnections.id, connectionId))
        .limit(1);
      const decrypted = decryptCredentials<{ access_token: string; refresh_token: string }>(
        row!.credentialsEncrypted,
      );
      expect(decrypted.access_token).toBe("new-access");
      expect(decrypted.refresh_token).toBe("new-refresh");
      expect(row?.expiresAt).not.toBeNull();
      expect(row?.needsReconnection).toBe(false);
    });

    it("preserves the existing refresh_token if the provider didn't return a new one", async () => {
      const { connectionId } = await seedOAuthModelProviderConnection({
        orgId,
        applicationId,
        connectionProfileId,
        providerId: CLAUDE_PROVIDER,
        credentials: { access_token: "old-access", refresh_token: "kept-refresh" },
        expiresAt: new Date(Date.now() - 1_000),
      });

      mockFetch(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "rotated-access",
              token_type: "Bearer",
              expires_in: 3600,
              // No refresh_token field — defensive against partial provider responses
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );

      await forceRefreshOAuthModelProviderToken(connectionId);

      const [row] = await db
        .select({ credentialsEncrypted: userProviderConnections.credentialsEncrypted })
        .from(userProviderConnections)
        .where(eq(userProviderConnections.id, connectionId))
        .limit(1);
      const decrypted = decryptCredentials<{ refresh_token: string }>(row!.credentialsEncrypted);
      expect(decrypted.refresh_token).toBe("kept-refresh");
    });

    it("network error: surfaces as a non-fatal Error with descriptive message (does not flag connection)", async () => {
      const { connectionId } = await seedOAuthModelProviderConnection({
        orgId,
        applicationId,
        connectionProfileId,
        providerId: CLAUDE_PROVIDER,
        credentials: { access_token: "stale", refresh_token: "rt" },
        expiresAt: new Date(Date.now() - 1_000),
      });

      mockFetch(async () => {
        throw new Error("ECONNREFUSED");
      });

      let caught: unknown;
      try {
        await forceRefreshOAuthModelProviderToken(connectionId);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("ECONNREFUSED");
      // Network errors must NOT be classified as "revoked" — preserve retry-ability
      const [row] = await db
        .select({ needsReconnection: userProviderConnections.needsReconnection })
        .from(userProviderConnections)
        .where(eq(userProviderConnections.id, connectionId))
        .limit(1);
      expect(row?.needsReconnection).toBe(false);
    });
  });

  describe("resolveOAuthTokenForSidecar", () => {
    it("returns the cached token when expiry is far from now (no refresh fetch)", async () => {
      const { connectionId } = await seedOAuthModelProviderConnection({
        orgId,
        applicationId,
        connectionProfileId,
        providerId: CLAUDE_PROVIDER,
        credentials: { access_token: "cached-access", refresh_token: "rt" },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h from now
      });

      let fetchCalled = false;
      mockFetch(async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      });

      const result = await resolveOAuthTokenForSidecar(connectionId);
      expect(result.accessToken).toBe("cached-access");
      expect(result.providerPackageId).toBe(CLAUDE_PROVIDER);
      expect(fetchCalled).toBe(false);
    });

    it("triggers refresh when within REFRESH_LEAD_MS of expiry", async () => {
      const { connectionId } = await seedOAuthModelProviderConnection({
        orgId,
        applicationId,
        connectionProfileId,
        providerId: CLAUDE_PROVIDER,
        credentials: { access_token: "near-expiry", refresh_token: "rt" },
        // Within REFRESH_LEAD_MS (5 min) — should refresh proactively
        expiresAt: new Date(Date.now() + 60 * 1000),
      });

      mockFetch(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "rotated-eagerly",
              refresh_token: "rt2",
              token_type: "Bearer",
              expires_in: 3600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );

      const result = await resolveOAuthTokenForSidecar(connectionId);
      expect(result.accessToken).toBe("rotated-eagerly");
    });

    it("on needsReconnection=true: throws OAUTH_CONNECTION_NEEDS_RECONNECTION (no provider call)", async () => {
      const { connectionId } = await seedOAuthModelProviderConnection({
        orgId,
        applicationId,
        connectionProfileId,
        providerId: CLAUDE_PROVIDER,
        credentials: { access_token: "stale", refresh_token: "rt" },
        needsReconnection: true,
      });

      let fetchCalled = false;
      mockFetch(async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      });

      let caught: unknown;
      try {
        await resolveOAuthTokenForSidecar(connectionId);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).code).toBe("OAUTH_CONNECTION_NEEDS_RECONNECTION");
      expect(fetchCalled).toBe(false);
    });

    it("on unknown connection: throws notFound (404, not a 5xx crash)", async () => {
      let caught: unknown;
      try {
        await resolveOAuthTokenForSidecar("00000000-0000-0000-0000-000000000000");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(404);
    });
  });
});
