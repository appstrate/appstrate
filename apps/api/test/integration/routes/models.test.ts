// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";

const app = getTestApp();

describe("Models API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  /** Helper: create a provider key and return its ID (required for model creation). */
  async function createProviderKey(): Promise<string> {
    const res = await app.request("/api/provider-keys", {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        label: "Test Provider Key",
        api: "openai",
        baseUrl: "https://api.openai.com",
        apiKey: "sk-test-key-123",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    return body.id;
  }

  describe("GET /api/models", () => {
    it("returns models list (may include system models)", async () => {
      const res = await app.request("/api/models", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toBeArray();
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/models");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/models", () => {
    it("creates a model with a valid provider key", async () => {
      const providerKeyId = await createProviderKey();

      const res = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "GPT-4o",
          api: "openai",
          baseUrl: "https://api.openai.com",
          modelId: "gpt-4o",
          providerKeyId,
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.id).toBeDefined();
      expect(typeof body.id).toBe("string");
    });
  });

  describe("DELETE /api/models/:id", () => {
    it("deletes a model and returns 204", async () => {
      const providerKeyId = await createProviderKey();

      // Create a model
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "To Delete",
          api: "openai",
          baseUrl: "https://api.openai.com",
          modelId: "gpt-4o-mini",
          providerKeyId,
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as any;

      // Delete it
      const res = await app.request(`/api/models/${id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(204);
    });
  });

  describe("PUT /api/models/default", () => {
    it("sets the default model", async () => {
      const providerKeyId = await createProviderKey();

      // Create a model first
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Default Model",
          api: "openai",
          baseUrl: "https://api.openai.com",
          modelId: "gpt-4o",
          providerKeyId,
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as any;

      // Set it as default
      const res = await app.request("/api/models/default", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ modelId: id }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
    });

    it("clears the default model with null", async () => {
      const res = await app.request("/api/models/default", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ modelId: null }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.success).toBe(true);
    });
  });
});
