// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end cross-link contract for OAuth model provider pairings.
 *
 * Integration tests cover the pairing/import wiring in-process against the
 * synthetic `test-oauth` provider; this e2e closes the loop against the
 * live server with the two real registered providers shipped in the default
 * module set: `codex` (from `@appstrate/module-codex`) and `claude-code`
 * (from `@appstrate/module-claude-code`). Both are exercised in parallel
 * to pin the cross-link contract for hook-bearing AND hook-less providers
 * (codex requires an `accountId` identity claim; claude-code has none).
 *
 * Each test exercises the full operator loop observable from the dashboard:
 *
 *   1. POST /pairing            (mint, cookie-auth)
 *   2. GET  /pairing/:id        → pending
 *   3. POST /import bad bearer  → 410          (replay-proof)
 *   4. POST /import (helper sim, bearer-auth, body-supplied identity
 *      bypasses the JWT identity hook when present — exact path used by
 *      `@appstrate/connect-helper` when the upstream provider returns the
 *      identity in the OAuth response body)
 *   5. GET  /pairing/:id        → consumed + credentialId populated
 *   6. GET  /model-provider-credentials → new row carries
 *                                 `authMode:"oauth2"`, `source:"custom"`,
 *                                 `providerId:"<provider>"`,
 *                                 `needsReconnection:false`
 *   7. POST /import token replay → 410
 *   8. DELETE credential        → 204, gone from the list
 *   9. DELETE /pairing/<bogus>  → 204 idempotent (wrong-id is silent)
 *
 * The refresh-mid-run path lives in
 * `apps/api/test/integration/services/model-providers-refresh-worker.test.ts`
 * — it needs to fake the upstream `/token` endpoint, which only the
 * in-process mock OAuth server can do. The badge surface is covered by
 * `oauth-ui.ui.spec.ts`. This file is the only place that proves the
 * cross-link contract holds against the live HTTP pipeline.
 *
 * @tags @smoke
 */

import { test, expect } from "../../fixtures/api.fixture.ts";

interface ProviderCase {
  id: string;
  // `accountId` is only forwarded for providers that declare an
  // `extractTokenIdentity` hook + `requiredIdentityClaims: ["accountId"]`
  // (codex). Hook-less providers (claude-code) reject the import if a
  // body field they don't understand is required, so we omit it.
  requiresAccountId: boolean;
}

const PROVIDER_CASES: ProviderCase[] = [
  { id: "codex", requiresAccountId: true },
  { id: "claude-code", requiresAccountId: false },
];

interface PairingMintResponse {
  id: string;
  token: string;
  command: string;
  expiresAt: string;
}

interface PairingStatusResponse {
  id: string;
  status: "pending" | "consumed" | "expired";
  consumedAt: string | null;
  expiresAt: string;
  credentialId: string | null;
}

interface ImportResponse {
  credentialId: string;
  providerId: string;
  availableModelIds: string[];
  email?: string;
}

interface CredentialRow {
  id: string;
  authMode: "oauth2" | "api_key";
  source: "built-in" | "custom";
  providerId?: string;
  needsReconnection?: boolean;
  oauthEmail?: string | null;
}

for (const provider of PROVIDER_CASES) {
  test.describe(`OAuth Model Providers — pairing lifecycle (${provider.id}) @smoke`, () => {
    test("mint → consume → list → revoke (full cross-link contract)", async ({
      apiClient,
      request,
    }) => {
      // 1. Mint a pairing (session-auth + RBAC enforced by /pairing).
      const mintRes = await apiClient.post("/model-providers-oauth/pairing", {
        providerId: provider.id,
      });
      expect(mintRes.status()).toBe(200);
      const mint = (await mintRes.json()) as PairingMintResponse;
      expect(mint.id).toMatch(/^pair_[A-Za-z0-9_-]+$/);
      expect(mint.token).toMatch(/^appp_/);
      expect(mint.command).toContain("npx @appstrate/connect-helper@latest ");
      expect(mint.command).toContain(mint.token);
      expect(new Date(mint.expiresAt).getTime()).toBeGreaterThan(Date.now());

      // 2. Status is `pending` until the helper consumes the token.
      const pendingRes = await apiClient.get(`/model-providers-oauth/pairing/${mint.id}`);
      expect(pendingRes.status()).toBe(200);
      const pending = (await pendingRes.json()) as PairingStatusResponse;
      expect(pending.status).toBe("pending");
      expect(pending.consumedAt).toBeNull();
      expect(pending.credentialId).toBeNull();

      // 3. Replay-proof bearer: a token-shaped string that didn't come from
      //    a real mint MUST 410, not 401 (single error code, no enumeration).
      const replayBadRes = await request.post("/api/model-providers-oauth/import", {
        headers: {
          Authorization: "Bearer appp_garbage.notreallyatoken",
          "Content-Type": "application/json",
        },
        data: {
          providerId: provider.id,
          label: "should fail",
          accessToken: "x",
          refreshToken: "y",
        },
      });
      expect(replayBadRes.status()).toBe(410);

      // 4. Helper sim — bearer-only, no cookie/X-Org-Id/X-Application-Id.
      //    Body carries `email` and (for hook-bearing providers) `accountId`,
      //    which take precedence over the module's JWT identity hook (the
      //    helper does this when the OAuth response body already surfaces
      //    the identity slots).
      const SYNTHETIC_ACCOUNT_ID = "00000000-1111-4222-8333-444444444444";
      const SYNTHETIC_EMAIL = `pairing-e2e-${provider.id}-${Date.now()}@example.test`;
      const importBody: Record<string, unknown> = {
        providerId: provider.id,
        label: `E2E ${provider.id} pairing`,
        accessToken: `fake-${provider.id}-access-token`,
        refreshToken: `fake-${provider.id}-refresh-token`,
        expiresAt: Date.now() + 3600_000,
        email: SYNTHETIC_EMAIL,
      };
      if (provider.requiresAccountId) {
        importBody.accountId = SYNTHETIC_ACCOUNT_ID;
      }
      const importRes = await request.post("/api/model-providers-oauth/import", {
        headers: {
          Authorization: `Bearer ${mint.token}`,
          "Content-Type": "application/json",
        },
        data: importBody,
      });
      expect(importRes.status()).toBe(200);
      const imported = (await importRes.json()) as ImportResponse;
      expect(imported.providerId).toBe(provider.id);
      expect(imported.credentialId).toBeTruthy();
      expect(Array.isArray(imported.availableModelIds)).toBe(true);
      expect(imported.availableModelIds.length).toBeGreaterThan(0);

      try {
        // 5. Status flips to `consumed` and the credential id is linked back.
        const consumedRes = await apiClient.get(`/model-providers-oauth/pairing/${mint.id}`);
        expect(consumedRes.status()).toBe(200);
        const consumed = (await consumedRes.json()) as PairingStatusResponse;
        expect(consumed.status).toBe("consumed");
        expect(consumed.consumedAt).not.toBeNull();
        expect(consumed.credentialId).toBe(imported.credentialId);

        // 6. The credential surfaces in the org-wide list with the OAuth-extended
        //    shape the UI reads to render the badge.
        const listRes = await apiClient.get("/model-provider-credentials");
        expect(listRes.status()).toBe(200);
        const list = (await listRes.json()) as { data: CredentialRow[] };
        const row = list.data.find((r) => r.id === imported.credentialId);
        expect(row).toBeDefined();
        expect(row?.authMode).toBe("oauth2");
        expect(row?.source).toBe("custom");
        expect(row?.providerId).toBe(provider.id);
        expect(row?.needsReconnection).toBe(false);
        expect(row?.oauthEmail).toBe(SYNTHETIC_EMAIL);

        // 7. Same bearer cannot be replayed — pairings are single-use.
        const replayBody: Record<string, unknown> = {
          providerId: provider.id,
          label: "replay attempt",
          accessToken: "fake",
          refreshToken: "fake",
        };
        if (provider.requiresAccountId) {
          replayBody.accountId = SYNTHETIC_ACCOUNT_ID;
        }
        const replayConsumedRes = await request.post("/api/model-providers-oauth/import", {
          headers: {
            Authorization: `Bearer ${mint.token}`,
            "Content-Type": "application/json",
          },
          data: replayBody,
        });
        expect(replayConsumedRes.status()).toBe(410);
      } finally {
        // 8. Always revoke the credential we created so this test is rerunnable
        //    against a long-lived `reuseExistingServer` instance.
        const deleteRes = await apiClient.delete(
          `/model-provider-credentials/${imported.credentialId}`,
        );
        expect([204, 404]).toContain(deleteRes.status());

        const listAfter = await apiClient.get("/model-provider-credentials");
        const after = (await listAfter.json()) as { data: CredentialRow[] };
        expect(after.data.find((r) => r.id === imported.credentialId)).toBeUndefined();
      }

      // 9. Cancelling a pairing is idempotent — wrong/unknown id is silent 204
      //    (matches GET's wrong-org 404 posture: never confirm existence).
      const cancelBogusRes = await apiClient.delete(
        "/model-providers-oauth/pairing/pair_unknownidentifier",
      );
      expect(cancelBogusRes.status()).toBe(204);
    });
  });
}
