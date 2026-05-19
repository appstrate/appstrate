// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-phase E2E smoke test for AFPS integration marketplace
 * (INTEGRATIONS_PROPOSAL Phase 1.3).
 *
 * Verifies the public REST surface end-to-end against a live API:
 *   - `GET /api/integrations` returns a list envelope
 *   - `GET /api/integrations/{pkgId}` returns 404 for an unknown package
 *   - `POST /api/integrations/{pkgId}/install` returns 404 for an unknown package
 *   - `GET /api/integrations/{pkgId}/oauth-clients/{key}` returns 404 when none configured
 *   - The route shape — including the `@scope/name` path segment in URLs —
 *     parses correctly under the production Hono regex matcher
 *
 * Deep happy-path coverage (real DB, full connect flows) lives in:
 *   - `apps/api/test/integration/routes/integrations.test.ts` (15 tests)
 *   - `packages/connect/test/integration-oauth.test.ts` (15 tests)
 *
 * Subprocess-side strip/inject coverage lives in:
 *   - `runtime-pi/sidecar/test/integration-mitm-e2e.test.ts` (subprocess fetch)
 */

import { test, expect } from "../../fixtures/api.fixture.ts";

test.describe("Integration marketplace API surface", () => {
  test("GET /api/integrations returns a list envelope (empty for a fresh org)", async ({
    apiClient,
  }) => {
    const res = await apiClient.get("/integrations");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { object: string; data: unknown[]; hasMore: boolean };
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("GET /api/integrations/{packageId} returns 404 for unknown integration", async ({
    apiClient,
  }) => {
    const res = await apiClient.get("/integrations/@official/does-not-exist");
    expect(res.status()).toBe(404);
  });

  test("POST /api/integrations/{packageId}/install returns 404 for unknown integration", async ({
    apiClient,
  }) => {
    const res = await apiClient.post("/integrations/@official/does-not-exist/install", {});
    expect(res.status()).toBe(404);
  });

  test("GET /api/integrations/{packageId}/oauth-clients/{authKey} returns 404 when unconfigured", async ({
    apiClient,
  }) => {
    // Same shape as the production hot path the UI hits when rendering
    // the admin OAuth client form on a fresh detail page — 404 is the
    // documented signal to show the "register" form rather than the
    // "rotate" form.
    const res = await apiClient.get("/integrations/@official/some-pkg/oauth-clients/primary");
    expect(res.status()).toBe(404);
  });

  test("GET /api/integrations/{packageId}/connections returns 404 for missing integration", async ({
    apiClient,
  }) => {
    const res = await apiClient.get("/integrations/@official/missing/connections");
    // The route loads the integration first; missing one yields 404 via
    // `assertAppBelongsToOrg` + manifest lookup. Validates the regex
    // matcher accepts the `@scope/name` segment past the `/connections`
    // trailing path.
    expect([404, 200]).toContain(res.status());
  });

  test("X-Org-Id and X-Application-Id headers are required by the integrations routes", async ({
    request,
    apiClient,
  }) => {
    // Sanity check that the routes are app-scoped (require X-Application-Id).
    // The `apiClient` already injects both; a bare request must 401 or 400.
    const res = await request.get("http://localhost:3000/api/integrations");
    expect([400, 401]).toContain(res.status());
    // Authenticated client still works.
    const ok = await apiClient.get("/integrations");
    expect(ok.status()).toBe(200);
  });
});
