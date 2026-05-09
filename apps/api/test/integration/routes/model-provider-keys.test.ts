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

  describe("GET /api/model-provider-keys", () => {
    it("returns list of model provider keys", async () => {
      const res = await app.request("/api/model-provider-keys", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toBeArray();
      // May include system model provider keys loaded at boot — just verify shape
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/model-provider-keys");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/model-provider-keys", () => {
    it("creates a model provider key", async () => {
      const res = await app.request("/api/model-provider-keys", {
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

  describe("PUT /api/model-provider-keys/:id", () => {
    it("updates model provider key label", async () => {
      // Create a model provider key first
      const createRes = await app.request("/api/model-provider-keys", {
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
      const res = await app.request(`/api/model-provider-keys/${id}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ label: "Updated Label" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe(id);
    });
  });

  describe("DELETE /api/model-provider-keys/:id", () => {
    it("deletes a model provider key and returns 204", async () => {
      // Create a model provider key first
      const createRes = await app.request("/api/model-provider-keys", {
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
      const res = await app.request(`/api/model-provider-keys/${id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(204);

      // Verify it is gone
      const listRes = await app.request("/api/model-provider-keys", {
        headers: authHeaders(ctx),
      });
      const body = (await listRes.json()) as any;
      const found = body.data.find((k: { id: string }) => k.id === id);
      expect(found).toBeUndefined();
    });
  });
});
