// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level tests for `POST /api/model-providers-oauth/import`.
 *
 * The route is bearer-only (pairing token). The happy-path import flow + the
 * pairing/credentials-mutation contract is covered in
 * `model-providers-oauth-import-pairing-bearer.test.ts`; this file pins the
 * post-consume Zod refine and the bearer-required check.
 */

import { describe, it, expect, beforeEach } from "bun:test";
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

  it("returns 400 when the body providerId does not match the pairing", async () => {
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
