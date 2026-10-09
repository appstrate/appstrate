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
 * Edge cases under test — every refusal is a 410 `oauth_connection_needs_reconnection` or a 502,
 * with its `cause` extension:
 *   - `invalid_grant` from the provider → blob flagged `needsReconnection=true`, `refresh_token_revoked`.
 *   - Already-flagged blob → `connection_flagged` short-circuit (no provider call).
 *   - Missing `refreshToken` in stored blob → flagged, `refresh_token_missing`.
 *   - Successful refresh rotates `accessToken`+`refreshToken`+`expiresAt` in DB.
 *   - Network error → 502 `upstream_transient`, nothing flagged.
 *   - A refused client → 502 `oauth_client_rejected`, never counted.
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
  recordModelCredentialRefreshFailure,
  type OAuthBlob,
} from "../../../src/services/model-providers/credentials.ts";
import {
  forceRefreshOAuthModelProviderToken,
  resolveOAuthTokenForSidecar,
} from "../../../src/services/model-providers/token-resolver.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import { getEnv } from "@appstrate/env";

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
  providerId: "test-oauth";
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

/** The refusal `run` throws: an `ApiError` of `status` carrying `cause`. */
async function refusal(run: () => Promise<unknown>): Promise<ApiError> {
  let caught: unknown;
  try {
    await run();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ApiError);
  return caught as ApiError;
}

const NEEDS_RECONNECTION = "oauth_connection_needs_reconnection";

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
    it("on invalid_grant: flags needsReconnection=true and throws the 410 refresh_token_revoked", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "test-oauth",
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

      expect(await refusal(() => forceRefreshOAuthModelProviderToken(id))).toMatchObject({
        code: NEEDS_RECONNECTION,
        status: 410,
        extensions: { cause: "refresh_token_revoked" },
      });

      const blob = await readBlob(id);
      expect(blob.needsReconnection).toBe(true);
    });

    it("on a 2xx invalid_grant error object: flags needsReconnection and throws refresh_token_revoked, never echoing the body", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "test-oauth",
        accessToken: "stale",
        refreshToken: "rt-revoked",
        expiresAtMs: Date.now() - 10_000,
      });

      // Some IdPs answer a failed grant with 200 + an RFC 6749 §5.2 error object,
      // and may echo a token beside it.
      mockFetch(
        async () =>
          new Response(
            JSON.stringify({ error: "invalid_grant", refresh_token: "echoed-secret-rt" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );

      const caught = await refusal(() => forceRefreshOAuthModelProviderToken(id));
      expect(caught).toMatchObject({
        code: NEEDS_RECONNECTION,
        status: 410,
        extensions: { cause: "refresh_token_revoked" },
      });
      expect(caught.message).not.toContain("echoed-secret-rt");
      expect(caught.message).not.toContain("{");

      const blob = await readBlob(id);
      expect(blob.needsReconnection).toBe(true);
    });

    it("on already-flagged credential: short-circuits with connection_flagged (no fetch)", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "test-oauth",
        accessToken: "stale",
        refreshToken: "rt-1",
        needsReconnection: true,
      });

      let fetchCalled = false;
      mockFetch(async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      });

      expect(await refusal(() => forceRefreshOAuthModelProviderToken(id))).toMatchObject({
        code: NEEDS_RECONNECTION,
        status: 410,
        extensions: { cause: "connection_flagged" },
      });
      expect(fetchCalled).toBe(false);
    });

    it("on missing refresh_token: flags needsReconnection and throws refresh_token_missing", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "test-oauth",
        accessToken: "only-access-token",
        refreshToken: "",
      });

      let fetchCalled = false;
      mockFetch(async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      });

      expect(await refusal(() => forceRefreshOAuthModelProviderToken(id))).toMatchObject({
        code: NEEDS_RECONNECTION,
        status: 410,
        extensions: { cause: "refresh_token_missing" },
      });
      expect(fetchCalled).toBe(false);

      const blob = await readBlob(id);
      expect(blob.needsReconnection).toBe(true);
    });

    it("on success: rotates accessToken + refreshToken + expiresAt in DB", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "test-oauth",
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
        providerId: "test-oauth",
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

    it("refreshes even when the stored token is nowhere near expiry", async () => {
      // "Force a refresh regardless of expiry" is this function's contract and
      // the sidecar calls it precisely because the provider just answered 401.
      // Every other test here seeds an expired/near-expired token, so the
      // freshness short-circuit inside `dedupedRefresh` was never exercised:
      // with an hour of remaining lifetime it returned the dead token, the
      // provider was never contacted, and the sidecar retried the same 401.
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "test-oauth",
        accessToken: "revoked-but-unexpired",
        refreshToken: "rt",
        expiresAtMs: Date.now() + 60 * 60 * 1000,
      });

      let fetchCalled = false;
      mockFetch(async () => {
        fetchCalled = true;
        return new Response(
          JSON.stringify({
            access_token: "rotated",
            refresh_token: "rt2",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const result = await forceRefreshOAuthModelProviderToken(id);

      expect(fetchCalled).toBe(true);
      expect(result.accessToken).toBe("rotated");
      expect((await readBlob(id)).accessToken).toBe("rotated");
    });

    it("network error: a 502 upstream_transient naming it, the credential not flagged", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "test-oauth",
        accessToken: "stale",
        refreshToken: "rt",
        expiresAtMs: Date.now() - 1_000,
      });

      mockFetch(async () => {
        throw new Error("ECONNREFUSED");
      });

      const caught = await refusal(() => forceRefreshOAuthModelProviderToken(id));
      expect(caught).toMatchObject({ status: 502, extensions: { cause: "upstream_transient" } });
      expect(caught.message).toContain("ECONNREFUSED");
      const blob = await readBlob(id);
      expect(blob.needsReconnection).toBe(false);
    });
  });

  describe("resolveOAuthTokenForSidecar", () => {
    it("returns the cached token when expiry is far from now (no refresh fetch)", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "test-oauth",
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
      expect(fetchCalled).toBe(false);
    });

    it("triggers refresh when within OAUTH_REFRESH_LEAD_MS of expiry", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "test-oauth",
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

    it("on needsReconnection=true: throws connection_flagged (no provider call)", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "test-oauth",
        accessToken: "stale",
        refreshToken: "rt",
        needsReconnection: true,
      });

      let fetchCalled = false;
      mockFetch(async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      });

      expect(await refusal(() => resolveOAuthTokenForSidecar(id))).toMatchObject({
        code: NEEDS_RECONNECTION,
        status: 410,
        extensions: { cause: "connection_flagged" },
      });
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

  /**
   * Transient-refresh-failure escalation — mirrors the integration_connections
   * escalation (#596). `recordModelCredentialRefreshFailure` increments a
   * per-credential counter on every transient (non-`invalid_grant`) refresh
   * failure and flips `blob.needsReconnection` ONLY when the streak crosses the
   * threshold AND the token is already expired past the grace window. A
   * successful token write resets the counter (via `updateOAuthCredentialTokens`).
   */
  describe("model-provider refresh-failure escalation", () => {
    const HOUR_MS = 3_600_000;

    async function readFailureRow(credentialId: string): Promise<{
      refreshFailureCount: number;
      needsReconnection: boolean;
    }> {
      const [row] = await db
        .select({
          refreshFailureCount: modelProviderCredentials.refreshFailureCount,
        })
        .from(modelProviderCredentials)
        .where(eq(modelProviderCredentials.id, credentialId));
      const blob = await readBlob(credentialId);
      return { ...row!, needsReconnection: blob.needsReconnection };
    }

    it("increments the counter but does NOT escalate while the token is still valid", async () => {
      // Token valid for another hour — a transient upstream blip must not brick it.
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "test-oauth",
        expiresAtMs: Date.now() + HOUR_MS,
      });

      // Drive the streak to (and past) the threshold.
      for (let i = 0; i < 4; i++) await recordModelCredentialRefreshFailure(orgId, id, 3, 3600);

      const row = await readFailureRow(id);
      expect(row.refreshFailureCount).toBe(4);
      expect(row.needsReconnection).toBe(false); // expiry gate blocks escalation
    });

    it("does NOT escalate while the token is expired but within the grace window", async () => {
      // Expired 10 min ago; grace is 1h → not yet escalatable.
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "test-oauth",
        expiresAtMs: Date.now() - 10 * 60_000,
      });

      for (let i = 0; i < 5; i++) await recordModelCredentialRefreshFailure(orgId, id, 3, 3600);

      const row = await readFailureRow(id);
      expect(row.refreshFailureCount).toBe(5);
      expect(row.needsReconnection).toBe(false);
    });

    it("escalates to needsReconnection once expired past grace AND streak hits threshold", async () => {
      // Expired 2h ago, grace 1h → past grace.
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "test-oauth",
        expiresAtMs: Date.now() - 2 * HOUR_MS,
      });

      await recordModelCredentialRefreshFailure(orgId, id, 3, 3600); // 1 — below threshold
      expect((await readFailureRow(id)).needsReconnection).toBe(false);
      await recordModelCredentialRefreshFailure(orgId, id, 3, 3600); // 2 — below threshold
      expect((await readFailureRow(id)).needsReconnection).toBe(false);
      await recordModelCredentialRefreshFailure(orgId, id, 3, 3600); // 3 — hits threshold

      const row = await readFailureRow(id);
      expect(row.refreshFailureCount).toBe(3);
      expect(row.needsReconnection).toBe(true);
    });

    it("never clears a pre-existing needsReconnection (monotonic flip)", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "test-oauth",
        expiresAtMs: Date.now() + HOUR_MS, // valid token — gate would say false
        needsReconnection: true, // but already flagged (e.g. revoke)
      });

      await recordModelCredentialRefreshFailure(orgId, id, 3, 3600);

      expect((await readFailureRow(id)).needsReconnection).toBe(true);
    });

    it("a successful refresh resets the failure streak", async () => {
      // Seed an expired token with an accumulated streak (not yet escalated).
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "test-oauth",
        expiresAtMs: Date.now() - 30 * 60_000,
      });
      await db
        .update(modelProviderCredentials)
        .set({ refreshFailureCount: 2 })
        .where(eq(modelProviderCredentials.id, id));

      mockFetch(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "fresh-access",
              refresh_token: "fresh-refresh",
              token_type: "Bearer",
              expires_in: 3600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );

      await forceRefreshOAuthModelProviderToken(id);

      const row = await readFailureRow(id);
      expect(row.refreshFailureCount).toBe(0);
      expect(row.needsReconnection).toBe(false);
    });

    it("a transient upstream failure during refresh increments the counter and rethrows", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "test-oauth",
        expiresAtMs: Date.now() - HOUR_MS,
      });

      mockFetch(
        async () =>
          new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }),
      );

      expect(await refusal(() => forceRefreshOAuthModelProviderToken(id))).toMatchObject({
        status: 502,
        extensions: { cause: "upstream_transient" },
      });

      // One transient failure < default threshold (5) → counted, not escalated.
      const row = await readFailureRow(id);
      expect(row.refreshFailureCount).toBe(1);
      expect(row.needsReconnection).toBe(false);
    });

    it("invalid_grant keeps its immediate flip — no streak required", async () => {
      const id = await seedOAuthCredential({
        orgId,
        userId,
        providerId: "test-oauth",
        expiresAtMs: Date.now() - 10_000, // expired → reReadFreshness lets doRefresh run
      });

      mockFetch(
        async () =>
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
      );

      expect(await refusal(() => forceRefreshOAuthModelProviderToken(id))).toMatchObject({
        code: NEEDS_RECONNECTION,
        extensions: { cause: "refresh_token_revoked" },
      });

      const row = await readFailureRow(id);
      expect(row.needsReconnection).toBe(true);
      // The revoked path does NOT touch the transient streak.
      expect(row.refreshFailureCount).toBe(0);
    });

    // A reconnect cannot repair a client the token endpoint refuses: never counted, never flagged,
    // even on a token expired past the grace window with a streak one short of the threshold.
    it.each(["invalid_client", "unauthorized_client"])(
      "a refused client (%s) answers 502 oauth_client_rejected without counting",
      async (error) => {
        const id = await seedOAuthCredential({
          orgId,
          userId,
          providerId: "test-oauth",
          expiresAtMs: Date.now() - 2 * HOUR_MS,
        });
        const max = getEnv().INTEGRATION_REFRESH_MAX_FAILURES;
        await db
          .update(modelProviderCredentials)
          .set({ refreshFailureCount: max - 1 })
          .where(eq(modelProviderCredentials.id, id));
        mockFetch(
          async () =>
            new Response(JSON.stringify({ error }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            }),
        );

        expect(await refusal(() => forceRefreshOAuthModelProviderToken(id))).toMatchObject({
          status: 502,
          extensions: { cause: "oauth_client_rejected" },
        });
        expect(await readFailureRow(id)).toEqual({
          refreshFailureCount: max - 1,
          needsReconnection: false,
        });
      },
    );
  });
});
