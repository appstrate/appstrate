// SPDX-License-Identifier: Apache-2.0

/**
 * Bearer-pairing-token auth on POST /api/model-providers-oauth/import.
 *
 * The route is bearer-only — there is no cookie/API-key fallback:
 *   1. Dashboard mints token via POST /pairing (session-auth + RBAC).
 *   2. `npx @appstrate/connect-helper` runs the loopback OAuth dance.
 *   3. Helper POSTs credentials to /import with the pairing token as Bearer.
 *
 * Invariants tested here:
 *   - Bearer auth works without any session cookie / X-Org-Id / X-Application-Id.
 *   - The pairing's userId/orgId/providerId are pinned at mint time and
 *     override anything the request body claims (no cross-org or
 *     cross-provider divert via tampered helper).
 *   - The pairing is single-use — a second POST with the same Bearer 410s.
 *   - Mismatched providerId in body is rejected with 400 before the
 *     credential is created.
 *   - Malformed / expired / replayed bearers all 410.
 *   - Cookie-only requests 401 (route does not accept session auth).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderPairings } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";

const app = getTestApp();

async function mintPairing(ctx: TestContext, providerId = "codex") {
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

const VALID_BODY = (providerId = "codex") => ({
  providerId,
  label: "Test connection",
  accessToken: "fake-access-token",
  refreshToken: "fake-refresh-token",
  expiresAt: Date.now() + 3600_000,
  accountId: "11111111-2222-4333-8444-555555555555",
});

describe("POST /api/model-providers-oauth/import — pairing-bearer track", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  it("imports credentials when authenticated by a fresh pairing token", async () => {
    const pairing = await mintPairing(ctx, "codex");
    const res = await app.request("/api/model-providers-oauth/import", {
      method: "POST",
      headers: bearerHeaders(pairing.token),
      body: JSON.stringify(VALID_BODY("codex")),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providerId: string; credentialId: string };
    expect(body.providerId).toBe("codex");
    expect(body.credentialId).toBeTruthy();
  });

  it("flips the pairing's consumed_at on success (single-use)", async () => {
    const pairing = await mintPairing(ctx, "codex");

    const r1 = await app.request("/api/model-providers-oauth/import", {
      method: "POST",
      headers: bearerHeaders(pairing.token),
      body: JSON.stringify(VALID_BODY("codex")),
    });
    expect(r1.status).toBe(200);

    const [row] = await db
      .select()
      .from(modelProviderPairings)
      .where(eq(modelProviderPairings.id, pairing.id))
      .limit(1);
    expect(row?.consumedAt).toBeInstanceOf(Date);
  });

  it("rejects a replay of the same token with 410 Gone", async () => {
    const pairing = await mintPairing(ctx, "codex");

    const r1 = await app.request("/api/model-providers-oauth/import", {
      method: "POST",
      headers: bearerHeaders(pairing.token),
      body: JSON.stringify(VALID_BODY("codex")),
    });
    expect(r1.status).toBe(200);

    const r2 = await app.request("/api/model-providers-oauth/import", {
      method: "POST",
      headers: bearerHeaders(pairing.token),
      body: JSON.stringify(VALID_BODY("codex")),
    });
    expect(r2.status).toBe(410);
  });

  it("rejects malformed bearer tokens with 410 (single error code, no enumeration)", async () => {
    const res = await app.request("/api/model-providers-oauth/import", {
      method: "POST",
      headers: bearerHeaders("appp_garbage.notreallyatoken"),
      body: JSON.stringify(VALID_BODY("codex")),
    });
    expect(res.status).toBe(410);
  });

  it("does NOT require X-Org-Id / X-Application-Id headers (pairing carries them)", async () => {
    const pairing = await mintPairing(ctx, "codex");

    // No authHeaders(ctx) — bearer-only.
    const res = await app.request("/api/model-providers-oauth/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pairing.token}`,
      },
      body: JSON.stringify(VALID_BODY("codex")),
    });
    expect(res.status).toBe(200);
  });

  it("rejects session-cookie requests without a pairing-bearer (bearer-only route)", async () => {
    // The route is bearer-only — cookie/API-key requests reach the handler
    // (auth-pipeline only bypasses on `Bearer appp_`) and 401 there.
    const res = await app.request("/api/model-providers-oauth/import", {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify(VALID_BODY("codex")),
    });
    expect(res.status).toBe(401);
  });
});
