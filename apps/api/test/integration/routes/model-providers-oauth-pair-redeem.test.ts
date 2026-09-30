// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical pair-redeem route — `POST /api/model-providers-oauth/pair/redeem`.
 *
 * Single-use / cross-org / cross-provider invariants live in
 * `model-providers-oauth-pair-redeem-bearer.test.ts`. This file covers
 * the canonical-path-specific contract:
 *   - The canonical path successfully redeems a fresh pairing token.
 *   - The canonical path does NOT emit any deprecation header.
 *   - The redeem response reports the provider's whole offer (the helper's
 *     terminal summary).
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import {
  createOAuthCredential,
  markCredentialNeedsReconnection,
} from "../../../src/services/model-providers/credentials.ts";
import { createOrgModel } from "../../../src/services/org-models.ts";
import { getModelProvider } from "../../../src/services/model-providers/registry.ts";
import { listCatalogModels } from "../../../src/services/model-catalog.ts";

const app = getTestApp();

async function mintPairing(ctx: TestContext, providerId = "test-oauth", credentialId?: string) {
  const res = await app.request("/api/model-providers-oauth/pairing", {
    method: "POST",
    headers: authHeaders(ctx, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      providerId,
      ...(credentialId ? { credentialId } : {}),
    }),
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
  access_token: "fake-access-token",
  refresh_token: "fake-refresh-token",
  expiresAt: Date.now() + 3600_000,
  account_id: "11111111-2222-4333-8444-555555555555",
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
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.providerId).toBe("test-oauth");
    expect(body.credentialId).toBeTruthy();
    expect(Array.isArray(body.available_model_ids)).toBe(true);
    for (const other of ["provider_id", "credential_id", "availableModelIds"]) {
      expect(body).not.toHaveProperty(other);
    }
  });

  it("reconnects the targeted credential in place", async () => {
    const originalCredentialId = await createOAuthCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      providerId: "test-oauth",
      label: "Target connection",
      accessToken: "expired-access",
      refreshToken: "revoked-refresh",
      expiresAt: Date.now() - 60_000,
      email: "same-account@example.test",
    });
    const modelId = await createOrgModel(
      ctx.orgId,
      "Target model",
      "test-model",
      ctx.user.id,
      originalCredentialId,
    );
    await markCredentialNeedsReconnection(ctx.orgId, originalCredentialId);

    const pairing = await mintPairing(ctx, "test-oauth", originalCredentialId);
    const reconnect = await app.request("/api/model-providers-oauth/pair/redeem", {
      method: "POST",
      headers: bearerHeaders(pairing.token),
      body: JSON.stringify({
        ...VALID_BODY("test-oauth"),
        label: "Ignored replacement label",
        access_token: "fresh-access-token",
        refresh_token: "fresh-refresh-token",
        email: "same-account@example.test",
      }),
    });
    expect(reconnect.status).toBe(200);
    const reconnected = (await reconnect.json()) as { credentialId: string };
    expect(reconnected.credentialId).toBe(originalCredentialId);

    const credentialsResponse = await app.request("/api/model-provider-credentials", {
      headers: authHeaders(ctx),
    });
    expect(credentialsResponse.status).toBe(200);
    const credentials = (await credentialsResponse.json()) as {
      data: Array<{
        id: string;
        label: string;
        providerId?: string | null;
        needs_reconnection: boolean;
      }>;
    };
    expect(credentials.data.filter((credential) => credential.providerId === "test-oauth")).toEqual(
      [
        expect.objectContaining({
          id: originalCredentialId,
          label: "Target connection",
          needs_reconnection: false,
        }),
      ],
    );

    const modelsResponse = await app.request("/api/models", { headers: authHeaders(ctx) });
    expect(modelsResponse.status).toBe(200);
    const models = (await modelsResponse.json()) as {
      data: Array<{ id: string; credentialId: string | null; needs_reconnection: boolean }>;
    };
    expect(models.data.find((model) => model.id === modelId)).toEqual(
      expect.objectContaining({
        credentialId: originalCredentialId,
        needs_reconnection: false,
      }),
    );
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

/**
 * `@appstrate/connect-helper` prints `available_model_ids` from this response
 * and can print nothing else — its pairing bearer is single-use and already
 * consumed. It must be the provider's whole offer, not the narrow
 * `featuredModels` subset.
 *
 * Runs against the REAL `claude-code` definition (a `modelDiscovery: { mode:
 * "static" }` provider, like every OAuth provider shipped today) — a synthetic
 * stand-in would keep passing while the shipped list rots.
 */
describe("POST /api/model-providers-oauth/pair/redeem — reported model list", () => {
  let ctx: TestContext;

  beforeAll(() => {
    // Seed the canonical baseline rather than hand-registering `claude-code`.
    // The root preload (`test/setup/preload.ts`) discovers every
    // `packages/module-*` workspace package independently of the test `MODULES`
    // env var — which only gates the production loader — so the baseline
    // already carries the real definition. Hand-registering it would throw
    // "already registered" as soon as any earlier file in the shared `bun test`
    // process re-seeded; guarding that with an `if (!getModelProvider(...))`
    // only turned the registration into dead code that never ran, and left the
    // block seeding no baseline at all when an earlier file had emptied the
    // registry.
    seedTestModelProviders();
  });

  afterAll(() => {
    // `bun test` shares one process and the registry rejects duplicate ids —
    // restore the canonical baseline for the next file.
    seedTestModelProviders();
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  it("reports the provider's whole offer, in offer order", async () => {
    const pairing = await mintPairing(ctx, "claude-code");
    const redeem = await app.request("/api/model-providers-oauth/pair/redeem", {
      method: "POST",
      headers: bearerHeaders(pairing.token),
      body: JSON.stringify({
        providerId: "claude-code",
        access_token: "sk-ant-oat-fake",
        refresh_token: "sk-ant-ort-fake",
        expiresAt: Date.now() + 3600_000,
      }),
    });
    expect(redeem.status).toBe(200);
    const { available_model_ids } = (await redeem.json()) as { available_model_ids: string[] };

    const offer = listCatalogModels(getModelProvider("claude-code")!).map((m) => m.id);
    expect(offer.length).toBeGreaterThan(0);
    expect(available_model_ids).toEqual(offer);
  });

  it("pins the regression: the list carries the current Anthropic generation", async () => {
    // What started this work: the helper announced `claude-opus-4-*` months
    // after `claude-opus-5` shipped, because the redeem echoed a hand-curated
    // subset instead of the catalog-derived servable set.
    const pairing = await mintPairing(ctx, "claude-code");
    const redeem = await app.request("/api/model-providers-oauth/pair/redeem", {
      method: "POST",
      headers: bearerHeaders(pairing.token),
      body: JSON.stringify({
        providerId: "claude-code",
        access_token: "sk-ant-oat-fake",
        refresh_token: "sk-ant-ort-fake",
        expiresAt: Date.now() + 3600_000,
      }),
    });
    expect(redeem.status).toBe(200);
    const { available_model_ids } = (await redeem.json()) as { available_model_ids: string[] };
    expect(available_model_ids).toContain("claude-opus-5");
  });
});
