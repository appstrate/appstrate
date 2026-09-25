// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { auditEvents } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { registerModelProvider } from "../../../src/services/model-providers/registry.ts";
import { initSystemModelProviderKeys } from "../../../src/services/model-registry.ts";
import { getModelProvider } from "../../../src/services/model-providers/registry.ts";
import { listCatalogModels, lookupCatalogModel } from "../../../src/services/model-catalog.ts";

const app = getTestApp();

/** Synthetic api-key provider whose listing is unauthenticated (`publicModelListing`). */
const PUBLIC_LISTING_PROVIDER_ID = "test-public-listing-route";
/** An id Pi's OpenCode Go records serve. */
const P_ONE = "kimi-k2.6";

function registerPublicListingProvider(): void {
  try {
    registerModelProvider({
      providerId: PUBLIC_LISTING_PROVIDER_ID,
      displayName: "Test Public Listing",
      iconUrl: "openai",
      apiShape: "openai-completions",
      defaultBaseUrl: "https://public-listing.example.test/v1",
      baseUrlOverridable: false,
      authMode: "api_key",
      catalogProviderId: "opencode-go",
      featuredModels: [P_ONE],
      publicModelListing: true,
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
    it("serves each model's catalog cost, tiers included", async () => {
      const res = await app.request("/api/model-provider-credentials/registry", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { providerId: string; models: { id: string; cost: unknown }[] }[];
      };
      const openai = body.data.find((p) => p.providerId === "openai");
      const gpt = openai!.models.find((m) => m.id === "gpt-5.5");
      // Compared against the catalog, and not vacuous: gpt-5.5 carries tiers.
      const catalogCost = lookupCatalogModel(getModelProvider("openai")!, "gpt-5.5")?.cost;
      expect(catalogCost?.tiers?.length).toBeGreaterThan(0);
      expect(gpt!.cost).toEqual(catalogCost!);
    });

    it("lists the provider's whole offer, flagging exactly its featured ids (xai)", async () => {
      const res = await app.request("/api/model-provider-credentials/registry", {
        headers: authHeaders(ctx),
      });
      const body = (await res.json()) as {
        data: { providerId: string; models: { id: string; featured: boolean }[] }[];
      };
      const xai = body.data.find((p) => p.providerId === "xai")!;
      const def = getModelProvider("xai")!;
      expect(xai.models.map((m) => m.id)).toEqual(listCatalogModels(def).map((m) => m.id));
      const featured = def.featuredModels;
      expect(featured.length).toBeGreaterThan(0);
      for (const m of xai.models) expect(m.featured).toBe(featured.includes(m.id));
    });

    it("declares live model search on the providers that serve it, false elsewhere", async () => {
      const res = await app.request("/api/model-provider-credentials/registry", {
        headers: authHeaders(ctx),
      });
      const body = (await res.json()) as {
        data: { providerId: string; live_model_search: boolean }[];
      };
      const searched = body.data.filter((p) => p.live_model_search).map((p) => p.providerId);
      expect(searched).toEqual(["openrouter"]);
    });

    it("serves null for a model the catalog leaves unpriced", async () => {
      const res = await app.request("/api/model-provider-credentials/registry", {
        headers: authHeaders(ctx),
      });
      const body = (await res.json()) as {
        data: { providerId: string; models: { id: string; cost: unknown }[] }[];
      };
      // Pi prices OpenRouter's variable router with negative rates.
      const router = body.data
        .find((p) => p.providerId === "openrouter")!
        .models.find((m) => m.id === "openrouter/auto");
      expect(router).toBeDefined();
      expect(router!.cost).toBeNull();
    });

    it("lists the anthropic-messages custom endpoint with no featured models", async () => {
      const res = await app.request("/api/model-provider-credentials/registry", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          providerId: string;
          apiShape: string;
          baseUrlOverridable: boolean;
          models: unknown[];
        }[];
      };
      const custom = body.data.find((p) => p.providerId === "anthropic-compatible");
      expect(custom).toBeDefined();
      expect(custom!.baseUrlOverridable).toBe(true);
      expect(custom!.apiShape).toBe("anthropic-messages");
      // No catalog and no featured list: the form enumerates the endpoint
      // itself via /discover instead of offering a picker.
      expect(custom!.models).toEqual([]);
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
          api_key: "sk-test-key-123",
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

    it("names an unlabelled custom-endpoint credential after its host", async () => {
      // Several endpoints behind one provider entry would otherwise all be
      // called "OpenAI-compatible (custom)", told apart only by a ` (2)` suffix.
      const res = await app.request("/api/model-provider-credentials", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          providerId: "openai-compatible",
          api_key: "sk-local",
          base_url_override: "http://10.255.255.9:9/v1",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.label).toStartWith("10.255.255.9:9 · ");
    });
  });

  describe("wire casing (snake_case family)", () => {
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });

    it("rejects snake_case spellings of the carve-out name `providerId`", async () => {
      const create = await post("/api/model-provider-credentials", {
        provider_id: "openai",
        api_key: "sk-snake",
      });
      expect(create.status).toBe(400);
      const inlineTest = await post("/api/model-provider-credentials/test", {
        provider_id: "openai-compatible",
        base_url: "http://10.255.255.9:9",
        api_key: "sk-x",
      });
      expect(inlineTest.status).toBe(400);
      const discover = await post("/api/model-provider-credentials/discover", {
        provider_id: "openai-compatible",
        api_key: "sk-x",
      });
      expect(discover.status).toBe(400);
    });

    it("rejects camelCase `apiKey` / `baseUrlOverride` beside `providerId` on create", async () => {
      const res = await post("/api/model-provider-credentials", {
        providerId: "openai-compatible",
        apiKey: "sk-camel",
        baseUrlOverride: "http://10.255.255.9:9/v1",
      });
      expect(res.status).toBe(400);
    });

    it("rejects camelCase `baseUrl` / `apiKey` beside `providerId` on inline test", async () => {
      const res = await post("/api/model-provider-credentials/test", {
        providerId: "openai-compatible",
        baseUrl: "http://10.255.255.9:9",
        apiKey: "sk-x",
      });
      expect(res.status).toBe(400);
    });

    it("refuses an `apiShape` on inline test: the provider decides the shape", async () => {
      const res = await post("/api/model-provider-credentials/test", {
        providerId: "openai-compatible",
        apiShape: "openai-responses",
        base_url: "http://10.255.255.9:9",
        api_key: "sk-x",
      });
      expect(res.status).toBe(400);
    });

    it("rejects a camelCase `apiKey` on update", async () => {
      const created = await post("/api/model-provider-credentials", {
        providerId: "openai",
        api_key: "sk-original",
      });
      const { id } = (await created.json()) as { id: string };
      const res = await app.request(`/api/model-provider-credentials/${id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ apiKey: "sk-rotated" }),
      });
      expect(res.status).toBe(400);
    });

    it("emits `base_url`, never `baseUrl`, with the honoured override", async () => {
      const res = await post("/api/model-provider-credentials", {
        providerId: "openai-compatible",
        api_key: "sk-local",
        base_url_override: "http://10.255.255.9:9/v1",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.base_url).toBe("http://10.255.255.9:9/v1");
      expect(body).not.toHaveProperty("baseUrl");
    });
  });

  describe("PATCH /api/model-provider-credentials/:id", () => {
    it("updates the label and returns the full non-secret resource", async () => {
      // Create a model provider key first
      const createRes = await app.request("/api/model-provider-credentials", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Original Label",
          providerId: "openai",
          api_key: "sk-test-key-123",
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as any;

      // Update the label (and rotate the key — must not leak in the response).
      const res = await app.request(`/api/model-provider-credentials/${id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ label: "Updated Label", api_key: "sk-rotated-secret-456" }),
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

      // The audit trail keeps camelCase keys and never the rotated secret.
      const [audit] = await db
        .select({ after: auditEvents.after })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "model_provider_credential.updated"),
            eq(auditEvents.resourceId, id),
          ),
        );
      expect(audit?.after).toEqual({ label: "Updated Label" });
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
          api_key: "sk-test-key-123",
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
          api_key: "sk-anth-test",
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
   * (`build-model-test-request.test.ts`, `public-model-listing.test.ts`).
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
          base_url_override: "https://api.openai.com/v1",
          api_key: "sk-org-a",
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
          base_url_override: "http://10.255.255.9:9",
          api_key: "sk-local",
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
          providerId: "openai-compatible",
          base_url: "http://10.255.255.9:9",
          api_key: "sk-x",
        }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 when neither api_key nor credentialId is provided", async () => {
      const res = await app.request("/api/model-provider-credentials/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          providerId: "openai-compatible",
          base_url: "http://10.255.255.9:9",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 on missing base_url (Zod rejects)", async () => {
      const res = await app.request("/api/model-provider-credentials/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          providerId: "openai-compatible",
          api_key: "sk-x",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 200 + BLOCKED_URL when api_key is supplied inline with a private base_url", async () => {
      const res = await app.request("/api/model-provider-credentials/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          providerId: "openai-compatible",
          base_url: "http://10.255.255.9:9",
          api_key: "sk-inline",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body.error).toBe("BLOCKED_URL");
    });

    it("resolves the saved key's plaintext when only credentialId is provided", async () => {
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
          base_url_override: "http://10.255.255.9:9",
          api_key: "sk-stored",
        }),
      });
      const { id } = (await createRes.json()) as { id: string };

      const res = await app.request("/api/model-provider-credentials/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          providerId: "openai-compatible",
          base_url: "http://10.255.255.9:9",
          credentialId: id,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body.error).toBe("BLOCKED_URL");

      const snakeFallback = await app.request("/api/model-provider-credentials/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          providerId: "openai-compatible",
          base_url: "http://10.255.255.9:9",
          existing_key_id: id,
        }),
      });
      expect(snakeFallback.status).toBe(400);
    });

    it("validates through the provider's inference probe when providerId declares publicModelListing", async () => {
      // Loopback is on the test preload's egress allowlist. The listing answers
      // 200 to any key; only the chat endpoint authenticates — so AUTH_FAILED
      // proves the route handed providerId to testModelConfig.
      const server = Bun.serve({
        port: 0,
        fetch: (req) =>
          new URL(req.url).pathname.endsWith("/models")
            ? Response.json({ data: [{ id: P_ONE }] })
            : Response.json({ error: { type: "AuthError" } }, { status: 401 }),
      });
      const providerId = `test-public-listing-loopback-${server.port}`;
      const baseUrl = `http://127.0.0.1:${server.port}/v1`;
      registerModelProvider({
        providerId,
        displayName: "Test Public Listing (loopback)",
        iconUrl: "openai",
        apiShape: "openai-completions",
        defaultBaseUrl: baseUrl,
        baseUrlOverridable: false,
        authMode: "api_key",
        catalogProviderId: "opencode-go",
        featuredModels: [P_ONE],
        publicModelListing: true,
      });
      try {
        const res = await app.request("/api/model-provider-credentials/test", {
          method: "POST",
          headers: authHeaders(ctx, { "Content-Type": "application/json" }),
          body: JSON.stringify({
            providerId,
            base_url: baseUrl,
            api_key: "sk-bogus",
          }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; error?: string };
        expect(body.ok).toBe(false);
        expect(body.error).toBe("AUTH_FAILED");
      } finally {
        await server.stop(true);
      }
    });

    it("returns 400 when providerId is omitted", async () => {
      const res = await app.request("/api/model-provider-credentials/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          base_url: "http://10.255.255.9:9",
          api_key: "sk-x",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 on an unknown providerId", async () => {
      const res = await app.request("/api/model-provider-credentials/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          providerId: "no-such-provider",
          base_url: "http://10.255.255.9:9",
          api_key: "sk-x",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("falls through to 'API key is required' (400) when credentialId points to a non-existent key", async () => {
      // loadInferenceCredentials returns null → apiKey stays
      // undefined → route throws invalidRequest. Guards against a future
      // refactor that would silently treat an unresolved key as ok.
      const res = await app.request("/api/model-provider-credentials/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          providerId: "openai-compatible",
          base_url: "http://10.255.255.9:9",
          credentialId: "00000000-0000-0000-0000-000000000000",
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/model-provider-credentials/test — endpoint of a stored credential", () => {
    /** A loopback endpoint recording every request it receives. */
    function recordingServer() {
      const hits: { path: string; authorization: string | null }[] = [];
      const server = Bun.serve({
        port: 0,
        fetch: (req) => {
          hits.push({
            path: new URL(req.url).pathname,
            authorization: req.headers.get("authorization"),
          });
          return Response.json({ data: [] });
        },
      });
      return { server, hits, baseUrl: `http://127.0.0.1:${server.port}/v1` };
    }

    const testRoute = (body: Record<string, unknown>) =>
      app.request("/api/model-provider-credentials/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });

    async function createCredential(body: Record<string, unknown>): Promise<string> {
      const res = await app.request("/api/model-provider-credentials", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    }

    it("refuses a system credential", async () => {
      initSystemModelProviderKeys([
        { id: "system-test-route-key", providerId: "openai", apiKey: "sk-system", models: [] },
      ]);
      const foreign = recordingServer();
      try {
        const res = await testRoute({
          providerId: "openai-compatible",
          base_url: foreign.baseUrl,
          credentialId: "system-test-route-key",
        });
        expect(res.status).toBe(403);
        expect(foreign.hits).toEqual([]);
      } finally {
        await foreign.server.stop(true);
        initSystemModelProviderKeys([]);
      }
    });

    it("probes the stored endpoint with the stored key", async () => {
      const stored = recordingServer();
      try {
        const id = await createCredential({
          providerId: "openai-compatible",
          base_url_override: stored.baseUrl,
          api_key: "sk-stored",
        });
        const res = await testRoute({
          providerId: "openai-compatible",
          base_url: stored.baseUrl,
          credentialId: id,
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
        expect(stored.hits).toEqual([{ path: "/v1/models", authorization: "Bearer sk-stored" }]);
      } finally {
        await stored.server.stop(true);
      }
    });

    it("never sends a stored key to a base_url other than the credential's", async () => {
      const stored = recordingServer();
      const foreign = recordingServer();
      try {
        const custom = await createCredential({
          providerId: "openai-compatible",
          base_url_override: stored.baseUrl,
          api_key: "sk-stored",
        });
        const named = await createCredential({ providerId: "openai", api_key: "sk-named" });
        for (const body of [
          { providerId: "openai-compatible", credentialId: custom },
          { providerId: "openai-compatible", credentialId: named },
          { providerId: "openai", credentialId: named },
        ]) {
          const res = await testRoute({
            ...body,
            base_url: foreign.baseUrl,
          });
          expect(res.status).toBe(400);
          expect(((await res.json()) as { param?: string }).param).toBe("base_url");
        }
        expect(foreign.hits).toEqual([]);
        expect(stored.hits).toEqual([]);
      } finally {
        await stored.server.stop(true);
        await foreign.server.stop(true);
      }
    });

    it("takes the provider from the credential, not the caller", async () => {
      const stored = recordingServer();
      try {
        const id = await createCredential({
          providerId: "openai-compatible",
          base_url_override: stored.baseUrl,
          api_key: "sk-stored",
        });
        const res = await testRoute({
          providerId: "anthropic",
          base_url: stored.baseUrl,
          credentialId: id,
        });
        expect(res.status).toBe(200);
        // openai-completions listing auth, not anthropic's `x-api-key`.
        expect(stored.hits).toEqual([{ path: "/v1/models", authorization: "Bearer sk-stored" }]);
      } finally {
        await stored.server.stop(true);
      }
    });

    it("sends a caller-supplied key to a caller-supplied base_url only on an overridable provider", async () => {
      const foreign = recordingServer();
      try {
        const ok = await testRoute({
          providerId: "openai-compatible",
          base_url: foreign.baseUrl,
          api_key: "sk-typed",
        });
        expect(ok.status).toBe(200);
        expect(foreign.hits).toEqual([{ path: "/v1/models", authorization: "Bearer sk-typed" }]);

        registerPublicListingProvider(); // baseUrlOverridable: false
        const refused = await testRoute({
          providerId: PUBLIC_LISTING_PROVIDER_ID,
          base_url: foreign.baseUrl,
          api_key: "sk-typed",
        });
        expect(refused.status).toBe(400);
        expect(((await refused.json()) as { param?: string }).param).toBe("base_url");
        expect(foreign.hits).toHaveLength(1);
      } finally {
        await foreign.server.stop(true);
      }
    });
  });
});
