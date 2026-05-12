// SPDX-License-Identifier: Apache-2.0

/**
 * E2E smoke tests for OAuth Model Providers — API surface.
 *
 * Covers the public endpoints exposed by
 * `apps/api/src/routes/model-providers-oauth.ts`:
 *
 *   - `POST /api/model-providers-oauth/import` validates the body shape.
 *   - The internal `/internal/oauth-token/:id` endpoint is not reachable
 *     without the run token (sanity check on auth gating).
 *   - Listing model provider keys returns the OAuth-extended shape
 *     (`authMode`, `needsReconnection`).
 *
 * Provider-specific OAuth flow (live token import, claim extraction)
 * is covered by each module's own integration suite under
 * `packages/module-*/test/` — those tests assert per-provider hook
 * behavior and don't belong in the platform-level e2e.
 *
 * @tags @smoke
 */

import { test, expect } from "../../fixtures/api.fixture.ts";

const SYNTHETIC_UNKNOWN_PROVIDER = "@example/not-a-real-provider";

test.describe("OAuth Model Providers — API smoke", () => {
  test("import rejects an unknown providerId @smoke", async ({ apiClient }) => {
    const res = await apiClient.post("/model-providers-oauth/import", {
      providerId: SYNTHETIC_UNKNOWN_PROVIDER,
      label: "Should fail",
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
    });
    expect(res.status()).toBe(400);
  });

  test("import rejects an empty label @smoke", async ({ apiClient }) => {
    const res = await apiClient.post("/model-providers-oauth/import", {
      providerId: SYNTHETIC_UNKNOWN_PROVIDER,
      label: "",
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
    });
    expect(res.status()).toBe(400);
  });

  test("import rejects missing accessToken @smoke", async ({ apiClient }) => {
    const res = await apiClient.post("/model-providers-oauth/import", {
      providerId: SYNTHETIC_UNKNOWN_PROVIDER,
      label: "Pro",
      refreshToken: "fake-refresh",
    });
    expect(res.status()).toBe(400);
  });

  test("internal OAuth token endpoint requires a run token (no anonymous read) @smoke", async ({
    request,
  }) => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await request.get(`/api/internal/oauth-token/${fakeId}`, {
      maxRedirects: 0,
    });
    // Auth is enforced by the internal middleware — must be 401, NOT 404
    // (404 would mean the auth check is bypassable, leaking platform state).
    expect([401, 403]).toContain(res.status());
  });

  test("listing model provider keys returns OAuth-extended shape @smoke", async ({ apiClient }) => {
    const res = await apiClient.get("/model-provider-keys");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const rows = body.data ?? [];
    expect(Array.isArray(rows)).toBe(true);
    // Smoke: every row carries an `authMode` field (extended in Phase 6.2).
    // Even an empty list passes — but if there's at least one (system-provided),
    // it must have the field.
    for (const row of rows) {
      expect(row).toHaveProperty("authMode");
    }
  });
});
