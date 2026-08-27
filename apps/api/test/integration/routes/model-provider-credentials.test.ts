// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedOrgModelProviderOAuth } from "../../helpers/seed.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { registerModelProvider } from "../../../src/services/model-providers/registry.ts";
import { registerCatalog } from "../../../src/services/pricing-catalog.ts";
import xaiFeatured from "../../../src/data/featured-models.json" with { type: "json" };
import type { CatalogModelEntry } from "@appstrate/shared-types";

const app = getTestApp();

/**
 * Synthetic `modelDiscovery: { mode: "static" }` provider — a stand-in for the
 * subscription sign-ins (codex, claude-code), which the core suite must not
 * depend on (zero-footprint invariant). `s-absent` is deliberately outside the
 * catalog so the ∩-catalog filter stays pinned.
 */
const STATIC_PROVIDER_ID = "test-refresh-static";
const STATIC_CATALOG_ID = "test-refresh-static-catalog";

function registerStaticRefreshProvider(): void {
  const entry: CatalogModelEntry = {
    label: "Synthetic",
    contextWindow: 8192,
    maxTokens: 1024,
    capabilities: ["text"],
    cost: { input: 0, output: 0 },
  };
  try {
    registerCatalog(STATIC_CATALOG_ID, { "s-one": entry, "s-two": entry });
    registerModelProvider({
      providerId: STATIC_PROVIDER_ID,
      displayName: "Test Static Refresh",
      iconUrl: "anthropic",
      description: "Synthetic offline-validation provider.",
      apiShape: "anthropic-messages",
      defaultBaseUrl: "https://static.example.test",
      baseUrlOverridable: false,
      authMode: "oauth2",
      oauth: {
        clientId: "test-static-client",
        authorizationUrl: "https://auth.example.test/authorize",
        tokenUrl: "https://auth.example.test/token",
        refreshUrl: "https://auth.example.test/token",
        scopes: ["openid"],
        pkce: "S256",
      },
      catalogProviderId: STATIC_CATALOG_ID,
      featuredModels: ["s-one"],
      modelDiscoveryCandidates: ["s-one", "s-two", "s-absent"],
      modelDiscovery: { mode: "static" },
    });
  } catch {
    // Already registered in this process — the registry rejects duplicates.
  }
}

describe("Model Provider Keys API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  describe("GET /api/model-provider-credentials/registry", () => {
    it("fills cost from the pricing catalog when the inline definition omits it", async () => {
      // Catalog invariant: openai/anthropic/mistral are covered by the
      // vendored LiteLLM catalog, so `core-providers/index.ts` no longer
      // duplicates `cost` inline — the registry serializer must derive
      // it via `lookupCatalogModel(providerId, modelId)?.cost`. If this regresses,
      // the form UI and the run cost would diverge again.
      const res = await app.request("/api/model-provider-credentials/registry", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { providerId: string; models: { id: string; cost: unknown }[] }[];
      };
      const anthropic = body.data.find((p) => p.providerId === "anthropic");
      expect(anthropic).toBeDefined();
      const haiku = anthropic!.models.find((m) => m.id === "claude-haiku-4-5-20251001");
      expect(haiku).toBeDefined();
      expect(haiku!.cost).toEqual({
        input: expect.closeTo(1, 4),
        output: expect.closeTo(5, 4),
        cacheRead: expect.closeTo(0.1, 4),
        cacheWrite: expect.closeTo(1.25, 4),
      });
    });

    it("marks featured catalog models with featured: true (xai)", async () => {
      // xAI is in the LiteLLM catalog and its featured list is
      // auto-generated (data/featured-models.json). The picker must flag
      // exactly the generated ids `featured: true` and every other
      // catalog model `featured: false`.
      const res = await app.request("/api/model-provider-credentials/registry", {
        headers: authHeaders(ctx),
      });
      const body = (await res.json()) as {
        data: {
          providerId: string;
          models: { id: string; cost: unknown; featured: boolean }[];
        }[];
      };
      const xai = body.data.find((p) => p.providerId === "xai");
      expect(xai).toBeDefined();
      // The catalog ships 30+ xai models — the picker now exposes them all.
      expect(xai!.models.length).toBeGreaterThan(5);
      const generated = (xaiFeatured as Record<string, string[]>)["xai"] ?? [];
      expect(generated.length).toBeGreaterThan(0);
      for (const id of generated) {
        expect(xai!.models.find((m) => m.id === id)?.featured).toBe(true);
      }
      // Catalog-derived cost still flows for non-featured models.
      const grok4 = xai!.models.find((m) => m.id === "grok-4");
      expect(grok4?.cost).toEqual({ input: 3, output: 15 });
      // A non-featured xai model surfaces too.
      const grok2 = xai!.models.find((m) => m.id === "grok-2");
      expect(grok2?.featured).toBe(false);
    });

    it("projects only requested fields and drops the heavy models catalog", async () => {
      const res = await app.request(
        "/api/model-provider-credentials/registry?fields=providerId,authMode",
        { headers: authHeaders(ctx) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown>[] };
      expect(body.data.length).toBeGreaterThan(0);
      for (const entry of body.data) {
        // providerId is always kept; authMode requested; nothing else.
        expect(Object.keys(entry).sort()).toEqual(["authMode", "providerId"]);
        expect(entry).not.toHaveProperty("models");
        expect(entry).not.toHaveProperty("displayName");
      }
    });

    it("always keeps providerId even when not explicitly requested", async () => {
      const res = await app.request("/api/model-provider-credentials/registry?fields=authMode", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown>[] };
      expect(body.data[0]).toHaveProperty("providerId");
      expect(body.data[0]).toHaveProperty("authMode");
    });

    it("rejects an unknown field with 400 invalid_request", async () => {
      const res = await app.request(
        "/api/model-provider-credentials/registry?fields=providerId,bogus",
        { headers: authHeaders(ctx) },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; detail?: string };
      expect(body.code).toBe("invalid_request");
      expect(body.detail).toContain("bogus");
    });

    it("paginates with limit/offset and reports total + hasMore", async () => {
      const res = await app.request("/api/model-provider-credentials/registry?limit=2", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: unknown[];
        total: number;
        hasMore: boolean;
      };
      expect(body.data).toHaveLength(2);
      expect(body.total).toBeGreaterThan(2);
      expect(body.hasMore).toBe(true);
    });
  });

  describe("GET /api/model-provider-credentials", () => {
    it("returns list of model provider keys", async () => {
      const res = await app.request("/api/model-provider-credentials", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toBeArray();
      // May include system model provider keys loaded at boot — just verify shape
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/model-provider-credentials");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/model-provider-credentials", () => {
    it("creates a model provider key and returns the full non-secret resource", async () => {
      const res = await app.request("/api/model-provider-credentials", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Test Key",
          providerId: "openai",
          apiKey: "sk-test-key-123",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      // Bare resource (same shape as GET/list), not an id stub (#657).
      expect(body.id).toBeDefined();
      expect(typeof body.id).toBe("string");
      expect(body.label).toBe("Test Key");
      expect(body.source).toBe("custom");
      expect(body.providerId).toBe("openai");
      expect(body.authMode).toBe("api_key");
      expect(body.createdAt).toBeDefined();
      expect(body.updatedAt).toBeDefined();
      // Security: the api key / any secret material must NEVER be echoed back.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("sk-test-key-123");
      expect(body).not.toHaveProperty("apiKey");
      expect(body).not.toHaveProperty("credentialsEncrypted");
    });
  });

  describe("PUT /api/model-provider-credentials/:id", () => {
    it("updates the label and returns the full non-secret resource", async () => {
      // Create a model provider key first
      const createRes = await app.request("/api/model-provider-credentials", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Original Label",
          providerId: "openai",
          apiKey: "sk-test-key-123",
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as any;

      // Update the label (and rotate the key — must not leak in the response).
      const res = await app.request(`/api/model-provider-credentials/${id}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ label: "Updated Label", apiKey: "sk-rotated-secret-456" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // Bare updated resource (#657).
      expect(body.id).toBe(id);
      expect(body.label).toBe("Updated Label");
      expect(body.source).toBe("custom");
      // Security: neither the original nor the rotated key may appear.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("sk-test-key-123");
      expect(serialized).not.toContain("sk-rotated-secret-456");
      expect(body).not.toHaveProperty("apiKey");
      expect(body).not.toHaveProperty("credentialsEncrypted");
    });
  });

  describe("DELETE /api/model-provider-credentials/:id", () => {
    it("deletes a model provider key and returns 204", async () => {
      // Create a model provider key first
      const createRes = await app.request("/api/model-provider-credentials", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "To Delete",
          providerId: "openai",
          apiKey: "sk-test-key-123",
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as any;

      // Delete it
      const res = await app.request(`/api/model-provider-credentials/${id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(204);

      // Verify it is gone
      const listRes = await app.request("/api/model-provider-credentials", {
        headers: authHeaders(ctx),
      });
      const body = (await listRes.json()) as any;
      const found = body.data.find((k: { id: string }) => k.id === id);
      expect(found).toBeUndefined();
    });

    it("returns 409 CREDENTIAL_IN_USE when an org_models row still references it", async () => {
      // Create a credential.
      const createRes = await app.request("/api/model-provider-credentials", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Pinned",
          providerId: "anthropic",
          apiKey: "sk-anth-test",
        }),
      });
      const { id: credId } = (await createRes.json()) as { id: string };

      // Attach a model to it so the FK is non-empty.
      const modelRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        // `apiShape` / `baseUrl` are deliberately NOT part of this body — they
        // are pinned by the credential's `providerId`. They used to be sent and
        // silently stripped; the body is `.strict()` now, so they are gone.
        body: JSON.stringify({
          label: "Sonnet pinned",
          credentialId: credId,
          modelId: "claude-sonnet-4-6",
        }),
      });
      expect(modelRes.status).toBe(201);

      // Now attempt deletion — FK ON DELETE RESTRICT should surface as 409.
      const res = await app.request(`/api/model-provider-credentials/${credId}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("credential_in_use");
    });
  });

  /**
   * Two test endpoints exist:
   *   - POST /api/model-provider-credentials/:id/test — probe a saved key
   *   - POST /api/model-provider-credentials/test     — probe a candidate config
   *                                              before saving (or via an
   *                                              already-saved key id when
   *                                              the user has typed the
   *                                              api+baseUrl into the form)
   *
   * Both routes ultimately call `testModelConfig`, which fetches upstream.
   * Tests pin the boundary behaviour (auth, scoping, 404, 400, Zod) and
   * the SSRF short-circuit (`isBlockedUrl` returns BLOCKED_URL before any
   * fetch fires) — using `http://10.255.255.9:9` keeps the tests offline and
   * deterministic. Real upstream coverage lives at the unit level
   * (`build-inference-probe-request.test.ts` + `build-model-test-request.test.ts`).
   */
  describe("POST /api/model-provider-credentials/:id/test", () => {
    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/model-provider-credentials/some-id/test", {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });

    it("returns 404 when the id does not exist", async () => {
      // Regression: this route used to swallow the explicit `notFound()`
      // throw inside its catch and remap it to `internalError()` (500).
      // The fix re-throws ApiError before the catch's fallback so the
      // global error handler sees the 404.
      const res = await app.request(
        "/api/model-provider-credentials/00000000-0000-0000-0000-000000000000/test",
        {
          method: "POST",
          headers: authHeaders(ctx),
        },
      );
      expect(res.status).toBe(404);
    });

    it("returns 404 when the key belongs to another org (cross-org isolation)", async () => {
      // Create a key in org A.
      const createRes = await app.request("/api/model-provider-credentials", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Org A key",
          providerId: "openai-compatible",
          baseUrlOverride: "https://api.openai.com/v1",
          apiKey: "sk-org-a",
        }),
      });
      const { id } = (await createRes.json()) as { id: string };

      // Org B asks to test it.
      const ctxB = await createTestContext({ orgSlug: "org-b" });
      const res = await app.request(`/api/model-provider-credentials/${id}/test`, {
        method: "POST",
        headers: authHeaders(ctxB),
      });
      expect(res.status).toBe(404);
    });

    it("returns 200 + BLOCKED_URL when the saved key targets a private baseUrl (SSRF guard hits before any fetch)", async () => {
      // Use 10.255.255.9 (RFC 1918, NOT in the test preload's operator
      // allowlist — 127.0.0.1 is exempted there) → isBlockedEgressUrl
      // returns true → testModelConfig short-circuits with BLOCKED_URL,
      // no network call.
      // The test still exercises the route → service → loadInferenceCredentials
      // → testModelConfig wiring end-to-end; only the upstream call is short-circuited.
      const createRes = await app.request("/api/model-provider-credentials", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Local",
          providerId: "openai-compatible",
          baseUrlOverride: "http://10.255.255.9:9",
          apiKey: "sk-local",
        }),
      });
      const { id } = (await createRes.json()) as { id: string };

      const res = await app.request(`/api/model-provider-credentials/${id}/test`, {
        method: "POST",
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("BLOCKED_URL");
    });
  });

  describe("POST /api/model-provider-credentials/test (inline)", () => {
    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/model-provider-credentials/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiShape: "openai-responses",
          baseUrl: "http://10.255.255.9:9",
          apiKey: "sk-x",
        }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 when neither apiKey nor existingKeyId is provided", async () => {
      const res = await app.request("/api/model-provider-credentials/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          apiShape: "openai-responses",
          baseUrl: "http://10.255.255.9:9",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 on missing baseUrl (Zod rejects)", async () => {
      const res = await app.request("/api/model-provider-credentials/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          apiShape: "openai-responses",
          apiKey: "sk-x",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 200 + BLOCKED_URL when apiKey is supplied inline with a private baseUrl", async () => {
      const res = await app.request("/api/model-provider-credentials/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          apiShape: "openai-responses",
          baseUrl: "http://10.255.255.9:9",
          apiKey: "sk-inline",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body.error).toBe("BLOCKED_URL");
    });

    it("resolves the saved key's plaintext when only existingKeyId is provided", async () => {
      // Regression for the same wiring that broke as bug 2: the inline
      // /test route also goes through `loadInferenceCredentials`.
      // The test verifies the resolution succeeds end-to-end (we hit
      // BLOCKED_URL because the baseUrl is a private address — but to reach
      // BLOCKED_URL the route MUST have decrypted and threaded the key).
      const createRes = await app.request("/api/model-provider-credentials", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Inline-existing",
          providerId: "openai-compatible",
          baseUrlOverride: "http://10.255.255.9:9",
          apiKey: "sk-stored",
        }),
      });
      const { id } = (await createRes.json()) as { id: string };

      const res = await app.request("/api/model-provider-credentials/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          apiShape: "openai-responses",
          baseUrl: "http://10.255.255.9:9",
          existingKeyId: id,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body.error).toBe("BLOCKED_URL");
    });

    it("falls through to 'API key is required' (400) when existingKeyId points to a non-existent key", async () => {
      // loadInferenceCredentials returns null → apiKey stays
      // undefined → route throws invalidRequest. Guards against a future
      // refactor that would silently treat an unresolved key as ok.
      const res = await app.request("/api/model-provider-credentials/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          apiShape: "openai-responses",
          baseUrl: "http://10.255.255.9:9",
          existingKeyId: "00000000-0000-0000-0000-000000000000",
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  /**
   * `POST /:id/refresh-models` for a `mode: "static"` provider. The endpoint
   * is deliberately kept as a truthful no-op rather than 404-ing: the model
   * form drives both provider kinds through the same call, and the response
   * still has to be the credential's current list. The harness validates
   * every JSON body against the OpenAPI response schema, so these tests also
   * gate the documented shape (`outcome`, `probed_count`,
   * `available_model_ids`).
   */
  describe("POST /api/model-provider-credentials/:id/refresh-models (static provider)", () => {
    beforeAll(registerStaticRefreshProvider);
    afterAll(() => {
      // Restore the canonical baseline — `bun test` shares one process and the
      // registry rejects duplicate ids.
      seedTestModelProviders();
    });
    beforeEach(registerStaticRefreshProvider);

    it("returns the derived list with probed_count 0 and writes nothing", async () => {
      const cred = await seedOrgModelProviderOAuth({
        orgId: ctx.org.id,
        providerId: STATIC_PROVIDER_ID,
      });

      const res = await app.request(`/api/model-provider-credentials/${cred.id}/refresh-models`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        outcome: string;
        probed_count: number;
        available_model_ids: string[] | null;
      };
      expect(body.outcome).toBe("ok");
      // Zero upstream requests — the platform never spends a subscription
      // quota to enumerate models.
      expect(body.probed_count).toBe(0);
      // "s-absent" is filtered out: seeding would reject an uncatalogued id.
      expect(body.available_model_ids).toEqual(["s-one", "s-two"]);

      const [row] = await db
        .select({ ids: modelProviderCredentials.availableModelIds })
        .from(modelProviderCredentials)
        .where(eq(modelProviderCredentials.id, cred.id));
      expect(row?.ids ?? null).toBeNull();
    });

    it("ignores a stale persisted array instead of returning or refreshing it", async () => {
      // The production shape this whole change exists for: a row written once
      // at discovery time, never refreshed, still being served to the picker
      // long after the provider definition moved on.
      const cred = await seedOrgModelProviderOAuth({
        orgId: ctx.org.id,
        providerId: STATIC_PROVIDER_ID,
      });
      await db
        .update(modelProviderCredentials)
        .set({ availableModelIds: ["s-ancient"] })
        .where(eq(modelProviderCredentials.id, cred.id));

      const res = await app.request(`/api/model-provider-credentials/${cred.id}/refresh-models`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      const body = (await res.json()) as { available_model_ids: string[] | null };
      expect(body.available_model_ids).toEqual(["s-one", "s-two"]);

      // Still not written — the column is inert for this provider kind, which
      // is exactly why migration 0030 clears the historical rows.
      const [row] = await db
        .select({ ids: modelProviderCredentials.availableModelIds })
        .from(modelProviderCredentials)
        .where(eq(modelProviderCredentials.id, cred.id));
      expect(row?.ids).toEqual(["s-ancient"]);
    });

    it("exposes the same derived list on GET (list and refresh cannot disagree)", async () => {
      const cred = await seedOrgModelProviderOAuth({
        orgId: ctx.org.id,
        providerId: STATIC_PROVIDER_ID,
      });

      const res = await app.request("/api/model-provider-credentials", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { id: string; available_model_ids?: string[] | null }[];
      };
      const found = body.data.find((k) => k.id === cred.id);
      expect(found?.available_model_ids).toEqual(["s-one", "s-two"]);
    });
  });
});
