// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";

const app = getTestApp();

describe("Model Provider Keys API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
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
    it("creates a model provider key", async () => {
      const res = await app.request("/api/model-provider-credentials", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Test Key",
          api: "openai",
          baseUrl: "https://api.openai.com",
          apiKey: "sk-test-key-123",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.id).toBeDefined();
      expect(typeof body.id).toBe("string");
    });
  });

  describe("PUT /api/model-provider-credentials/:id", () => {
    it("updates model provider key label", async () => {
      // Create a model provider key first
      const createRes = await app.request("/api/model-provider-credentials", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Original Label",
          api: "openai",
          baseUrl: "https://api.openai.com",
          apiKey: "sk-test-key-123",
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as any;

      // Update the label
      const res = await app.request(`/api/model-provider-credentials/${id}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ label: "Updated Label" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe(id);
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
          api: "openai",
          baseUrl: "https://api.openai.com",
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
   * fetch fires) — using `http://127.0.0.1:9` keeps the tests offline and
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
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
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
      // Use 127.0.0.1 (loopback) → isBlockedUrl returns true →
      // testModelConfig short-circuits with BLOCKED_URL, no network call.
      // The test still exercises the route → service → loadModelProviderKeyCredentials
      // → testModelConfig wiring end-to-end; only the upstream call is short-circuited.
      const createRes = await app.request("/api/model-provider-credentials", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Local",
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:9",
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
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:9",
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
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:9",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 on missing baseUrl (Zod rejects)", async () => {
      const res = await app.request("/api/model-provider-credentials/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          api: "openai-responses",
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
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:9",
          apiKey: "sk-inline",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body.error).toBe("BLOCKED_URL");
    });

    it("resolves the saved key's plaintext when only existingKeyId is provided", async () => {
      // Regression for the same wiring that broke as bug 2: the inline
      // /test route also goes through `loadModelProviderKeyCredentials`.
      // The test verifies the resolution succeeds end-to-end (we hit
      // BLOCKED_URL because the baseUrl is loopback — but to reach
      // BLOCKED_URL the route MUST have decrypted and threaded the key).
      const createRes = await app.request("/api/model-provider-credentials", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Inline-existing",
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:9",
          apiKey: "sk-stored",
        }),
      });
      const { id } = (await createRes.json()) as { id: string };

      const res = await app.request("/api/model-provider-credentials/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:9",
          existingKeyId: id,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body.error).toBe("BLOCKED_URL");
    });

    it("falls through to 'API key is required' (400) when existingKeyId points to a non-existent key", async () => {
      // loadModelProviderKeyCredentials returns null → apiKey stays
      // undefined → route throws invalidRequest. Guards against a future
      // refactor that would silently treat an unresolved key as ok.
      const res = await app.request("/api/model-provider-credentials/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:9",
          existingKeyId: "00000000-0000-0000-0000-000000000000",
        }),
      });
      expect(res.status).toBe(400);
    });
  });
});
