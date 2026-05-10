// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth model providers token-resolver hardening (cf. SPEC §10).
 *
 * Covers the platform-side service that the sidecar's `/internal/oauth-token/*`
 * routes proxy to. The PROVIDER refresh URL is intercepted via `globalThis.fetch`
 * swap — same pattern as `llm-proxy.test.ts` — so no real network call leaves
 * the test process.
 *
 * Persistence model (Phase 4+): a single row in `model_provider_credentials`
 * carrying a `kind: "oauth"` blob. The resolver reads & writes there directly.
 *
 * Edge cases under test:
 *   - `invalid_grant` from the provider → blob flagged `needsReconnection=true`
 *     AND `OAUTH_REFRESH_REVOKED` raised (worker's structured-warn path).
 *   - Already-flagged blob → `OAUTH_CONNECTION_NEEDS_RECONNECTION` short-circuit
 *     (no provider call).
 *   - Missing `refreshToken` in stored blob → flagged + `OAUTH_REFRESH_TOKEN_MISSING`.
 *   - Successful refresh rotates `accessToken`+`refreshToken`+`expiresAt` in DB.
 *   - Network error surfaces as a non-fatal Error (no sidecar crash).
 *   - `resolveOAuthTokenForSidecar` returns the cached token when far from expiry.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { decryptCredentials } from "@appstrate/connect";
import { modelProviderCredentials } from "@appstrate/db/schema";
import {
  createOAuthCredential,
  type OAuthBlob,
} from "../../../src/services/model-provider-credentials.ts";
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

// ─── Seed helper ────────────────────────────────────────────

async function seedOAuthCredential(opts: {
  orgId: string;
  userId: string;
  providerId: "codex" | "claude-code";
  accessToken?: string;
  refreshToken?: string;
  expiresAtMs?: number | null;
  needsReconnection?: boolean;
}): Promise<string> {
  const id = await createOAuthCredential({
    orgId: opts.orgId,
    userId: opts.userId,
    label: `Test ${opts.providerId}`,
    providerId: opts.providerId,
    accessToken: opts.accessToken ?? "stale-access",
    refreshToken: opts.refreshToken ?? "stale-refresh",
    expiresAt: opts.expiresAtMs === undefined ? null : opts.expiresAtMs,
    scopesGranted: ["user:inference"],
  });
  if (opts.needsReconnection || opts.refreshToken === "") {
    // Force-rewrite the blob to mirror the requested edge-case shape (the
    // service layer doesn't expose a "create flagged" or "create with empty
    // refresh" path — write directly here for test setup only).
    const [row] = await db
      .select({ blob: modelProviderCredentials.credentialsEncrypted })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, id));
    const decrypted = decryptCredentials<OAuthBlob>(row!.blob);
    const next: OAuthBlob = {
      ...decrypted,
      ...(opts.needsReconnection !== undefined
        ? { needsReconnection: opts.needsReconnection }
        : {}),
      ...(opts.refreshToken === "" ? { refreshToken: "" } : {}),
    };
    const { encryptCredentials } = await import("@appstrate/connect");
    await db
      .update(modelProviderCredentials)
      .set({
        credentialsEncrypted: encryptCredentials(next as unknown as Record<string, unknown>),
      })
      .where(eq(modelProviderCredentials.id, id));
  }
  return id;
}

async function readBlob(credentialId: string): Promise<OAuthBlob> {
  const [row] = await db
    .select({ blob: modelProviderCredentials.credentialsEncrypted })
    .from(modelProviderCredentials)
    .where(eq(modelProviderCredentials.id, credentialId));
  return decryptCredentials<OAuthBlob>(row!.blob);
}

// ─── Tests ───────────────────────────────────────────────────

describe("OAuth model providers — token-resolver hardening", () => {
  let userId: string;
  let orgId: string;

  beforeEach(async () => {
    await truncateAll();
    const user = await createTestUser();
    userId = user.id;
    const { org } = await createTestOrg(userId, { slug: "testorg" });
    orgId = org.id;
  });

  afterEach(() => restoreFetch());

  describe("forceRefreshOAuthModelProviderToken", () => {
    it("on invalid_grant: flags needsReconnection=true and throws OAUTH_REFRESH_REVOKED", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "claude-code",
        accessToken: "stale",
        refreshToken: "rt-revoked",
        expiresAtMs: Date.now() - 10_000,
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
        await forceRefreshOAuthModelProviderToken(id);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).code).toBe("OAUTH_REFRESH_REVOKED");
      expect((caught as ApiError).status).toBe(410);

      const blob = await readBlob(id);
      expect(blob.needsReconnection).toBe(true);
    });

    it("on already-flagged credential: short-circuits with OAUTH_CONNECTION_NEEDS_RECONNECTION (no fetch)", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "claude-code",
        accessToken: "stale",
        refreshToken: "rt-1",
        needsReconnection: true,
      });

      let fetchCalled = false;
      mockFetch(async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      });

      let caught: unknown;
      try {
        await forceRefreshOAuthModelProviderToken(id);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).code).toBe("OAUTH_CONNECTION_NEEDS_RECONNECTION");
      expect(fetchCalled).toBe(false);
    });

    it("on missing refresh_token: flags needsReconnection and throws OAUTH_REFRESH_TOKEN_MISSING", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "claude-code",
        accessToken: "only-access-token",
        refreshToken: "",
      });

      let fetchCalled = false;
      mockFetch(async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      });

      let caught: unknown;
      try {
        await forceRefreshOAuthModelProviderToken(id);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).code).toBe("OAUTH_REFRESH_TOKEN_MISSING");
      expect(fetchCalled).toBe(false);

      const blob = await readBlob(id);
      expect(blob.needsReconnection).toBe(true);
    });

    it("on success: rotates accessToken + refreshToken + expiresAt in DB", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "claude-code",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAtMs: Date.now() - 10_000,
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

      const result = await forceRefreshOAuthModelProviderToken(id);
      expect(result.accessToken).toBe("new-access");
      expect(result.expiresAt).not.toBeNull();
      expect(result.expiresAt!).toBeGreaterThan(Date.now());

      const blob = await readBlob(id);
      expect(blob.accessToken).toBe("new-access");
      expect(blob.refreshToken).toBe("new-refresh");
      expect(blob.expiresAt).not.toBeNull();
      expect(blob.needsReconnection).toBe(false);
    });

    it("preserves the existing refresh_token if the provider didn't return a new one", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "claude-code",
        accessToken: "old-access",
        refreshToken: "kept-refresh",
        expiresAtMs: Date.now() - 1_000,
      });

      mockFetch(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "rotated-access",
              token_type: "Bearer",
              expires_in: 3600,
              // No refresh_token field — defensive against partial provider responses.
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );

      await forceRefreshOAuthModelProviderToken(id);

      const blob = await readBlob(id);
      expect(blob.refreshToken).toBe("kept-refresh");
    });

    it("network error: surfaces as a non-fatal Error with descriptive message (does not flag credential)", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "claude-code",
        accessToken: "stale",
        refreshToken: "rt",
        expiresAtMs: Date.now() - 1_000,
      });

      mockFetch(async () => {
        throw new Error("ECONNREFUSED");
      });

      let caught: unknown;
      try {
        await forceRefreshOAuthModelProviderToken(id);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("ECONNREFUSED");
      const blob = await readBlob(id);
      expect(blob.needsReconnection).toBe(false);
    });
  });

  describe("resolveOAuthTokenForSidecar", () => {
    it("returns the cached token when expiry is far from now (no refresh fetch)", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "claude-code",
        accessToken: "cached-access",
        refreshToken: "rt",
        expiresAtMs: Date.now() + 60 * 60 * 1000,
      });

      let fetchCalled = false;
      mockFetch(async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      });

      const result = await resolveOAuthTokenForSidecar(id);
      expect(result.accessToken).toBe("cached-access");
      expect(result.providerId).toBe("claude-code");
      expect(fetchCalled).toBe(false);
    });

    it("triggers refresh when within REFRESH_LEAD_MS of expiry", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "claude-code",
        accessToken: "near-expiry",
        refreshToken: "rt",
        expiresAtMs: Date.now() + 60 * 1000,
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

      const result = await resolveOAuthTokenForSidecar(id);
      expect(result.accessToken).toBe("rotated-eagerly");
    });

    it("on needsReconnection=true: throws OAUTH_CONNECTION_NEEDS_RECONNECTION (no provider call)", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "claude-code",
        accessToken: "stale",
        refreshToken: "rt",
        needsReconnection: true,
      });

      let fetchCalled = false;
      mockFetch(async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      });

      let caught: unknown;
      try {
        await resolveOAuthTokenForSidecar(id);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).code).toBe("OAUTH_CONNECTION_NEEDS_RECONNECTION");
      expect(fetchCalled).toBe(false);
    });

    it("on unknown credential: throws notFound (404, not a 5xx crash)", async () => {
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
