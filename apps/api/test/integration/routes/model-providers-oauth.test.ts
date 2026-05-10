// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level tests for `/api/model-providers-oauth/*`.
 *
 * Most of the OAuth import flow is covered service-side in
 * `services/oauth-model-providers-import.test.ts` — this file pins the
 * route's gates (auth + RBAC + MODEL_PROVIDERS_DISABLED soft-disable).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";

const app = getTestApp();

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

    it("returns 403 when the providerId is disabled", async () => {
      process.env.MODEL_PROVIDERS_DISABLED = "codex,claude-code";
      resetEnvCache();
      const res = await app.request("/api/model-providers-oauth/import", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          providerId: "codex",
          label: "Soft-disabled Codex import",
          accessToken: "at-x",
          refreshToken: "rt-x",
          expiresAt: Date.now() + 3600_000,
        }),
      });
      expect(res.status).toBe(403);
    });

    it("returns 400 (not 403) when the providerId is unknown", async () => {
      // The Zod refine (`isOAuthModelProvider`) fires before the env gate.
      // Confirms ordering: validation precedes soft-disable check.
      process.env.MODEL_PROVIDERS_DISABLED = "";
      resetEnvCache();
      const res = await app.request("/api/model-providers-oauth/import", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
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
        providerId: "codex",
        label: "x",
        accessToken: "at",
        refreshToken: "rt",
      }),
    });
    expect(res.status).toBe(401);
  });
});
