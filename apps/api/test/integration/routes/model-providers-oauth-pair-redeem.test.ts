// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical pair-redeem route — `POST /api/model-providers-oauth/pair/redeem`.
 *
 * Single-use / cross-org / cross-provider invariants live in
 * `model-providers-oauth-pair-redeem-bearer.test.ts`. This file covers
 * the canonical-path-specific contract:
 *   - The canonical path successfully redeems a fresh pairing token.
 *   - The canonical path does NOT emit any deprecation header.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";

const app = getTestApp();

async function mintPairing(ctx: TestContext, providerId = "test-oauth") {
  const res = await app.request("/api/model-providers-oauth/pairing", {
    method: "POST",
    headers: authHeaders(ctx, { "Content-Type": "application/json" }),
    body: JSON.stringify({ providerId }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    id: string;
    token: string;
    command: string;
    expiresAt: string;
  };
}

function bearerHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

const VALID_BODY = (providerId = "test-oauth") => ({
  providerId,
  label: "Test connection",
  accessToken: "fake-access-token",
  refreshToken: "fake-refresh-token",
  expiresAt: Date.now() + 3600_000,
  accountId: "11111111-2222-4333-8444-555555555555",
});

describe("POST /api/model-providers-oauth/pair/redeem — canonical route", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  it("redeems credentials when authenticated by a fresh pairing token", async () => {
    const pairing = await mintPairing(ctx, "test-oauth");
    const res = await app.request("/api/model-providers-oauth/pair/redeem", {
      method: "POST",
      headers: bearerHeaders(pairing.token),
      body: JSON.stringify(VALID_BODY("test-oauth")),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providerId: string; credentialId: string };
    expect(body.providerId).toBe("test-oauth");
    expect(body.credentialId).toBeTruthy();
  });

  it("does NOT emit Deprecation / Link successor-version response headers", async () => {
    const pairing = await mintPairing(ctx, "test-oauth");
    const res = await app.request("/api/model-providers-oauth/pair/redeem", {
      method: "POST",
      headers: bearerHeaders(pairing.token),
      body: JSON.stringify(VALID_BODY("test-oauth")),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Deprecation")).toBeNull();
    // Allow other Link headers from the framework, but not our successor-version one
    const link = res.headers.get("Link");
    expect(link === null || !link.includes("successor-version")).toBe(true);
  });

  it("rejects missing bearer with 401 (same contract as the alias)", async () => {
    const res = await app.request("/api/model-providers-oauth/pair/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY("test-oauth")),
    });
    expect(res.status).toBe(401);
  });

  it("rejects malformed bearer with 410 (single error code, no enumeration)", async () => {
    const res = await app.request("/api/model-providers-oauth/pair/redeem", {
      method: "POST",
      headers: bearerHeaders("appp_garbage.notreallyatoken"),
      body: JSON.stringify(VALID_BODY("test-oauth")),
    });
    expect(res.status).toBe(410);
  });
});
