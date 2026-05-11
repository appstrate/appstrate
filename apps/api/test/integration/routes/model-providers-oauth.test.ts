// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level tests for `POST /api/model-providers-oauth/import`.
 *
 * The route is bearer-only (pairing token). The happy-path import flow + the
 * pairing/credentials-mutation contract is covered in
 * `model-providers-oauth-import-pairing-bearer.test.ts`; this file pins the
 * post-consume gates (Zod refine + MODEL_PROVIDERS_DISABLED soft-disable)
 * and the bearer-required check.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";

const app = getTestApp();

async function mintPairing(ctx: TestContext, providerId = "test-oauth"): Promise<string> {
  const res = await app.request("/api/model-providers-oauth/pairing", {
    method: "POST",
    headers: authHeaders(ctx, { "Content-Type": "application/json" }),
    body: JSON.stringify({ providerId }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  return body.token;
}

describe("POST /api/model-providers-oauth/import", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  describe("MODEL_PROVIDERS_DISABLED gate", () => {
    const SNAPSHOT = process.env.MODEL_PROVIDERS_DISABLED;

    afterEach(() => {
      if (SNAPSHOT === undefined) delete process.env.MODEL_PROVIDERS_DISABLED;
      else process.env.MODEL_PROVIDERS_DISABLED = SNAPSHOT;
      resetEnvCache();
    });

    it("returns 403 when the providerId is disabled (race: pairing minted, provider disabled mid-flow)", async () => {
      // Mint the pairing while the provider is enabled — the gate fires
      // at consume-time on /import, after consumePairing() has run.
      const token = await mintPairing(ctx, "test-oauth");

      process.env.MODEL_PROVIDERS_DISABLED = "test-oauth";
      resetEnvCache();
      const res = await app.request("/api/model-providers-oauth/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          providerId: "test-oauth",
          label: "Soft-disabled Codex import",
          accessToken: "at-x",
          refreshToken: "rt-x",
          expiresAt: Date.now() + 3600_000,
        }),
      });
      expect(res.status).toBe(403);
    });

    it("returns 400 when the body providerId is unknown (Zod refine fires after consume)", async () => {
      process.env.MODEL_PROVIDERS_DISABLED = "";
      resetEnvCache();
      const token = await mintPairing(ctx, "test-oauth");
      const res = await app.request("/api/model-providers-oauth/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          providerId: "@unknown/provider",
          label: "x",
          accessToken: "at",
          refreshToken: "rt",
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  it("returns 401 without authentication", async () => {
    const res = await app.request("/api/model-providers-oauth/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "test-oauth",
        label: "x",
        accessToken: "at",
        refreshToken: "rt",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when a session cookie is presented without a pairing-bearer", async () => {
    // The route no longer accepts session auth — cookie callers reach the
    // handler (auth-pipeline only bypasses on `Bearer appp_`) and 401 there.
    const res = await app.request("/api/model-providers-oauth/import", {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        providerId: "test-oauth",
        label: "x",
        accessToken: "at",
        refreshToken: "rt",
      }),
    });
    expect(res.status).toBe(401);
  });
});
