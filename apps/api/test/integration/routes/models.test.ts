// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { encrypt } from "@appstrate/connect";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedOrgModelProviderKey, seedOrgModel } from "../../helpers/seed.ts";

const app = getTestApp();

describe("Models API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  /** Helper: create a model provider key and return its ID (required for model creation). */
  async function createProviderKey(): Promise<string> {
    const res = await app.request("/api/model-provider-keys", {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        label: "Test Model Provider Key",
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

    it("flags Anthropic OAuth credentials with keyKind='oauth'", async () => {
      // The CLI relies on this field to mirror the `sk-ant-oat-` prefix
      // in pi-ai's placeholder. Anthropic gates OAuth tokens to Claude
      // Code identity at the body level, so the body reshape must happen
      // locally before the request reaches the proxy. Mis-flagging here
      // breaks `appstrate run` against any OAuth-keyed preset with an
      // opaque 429 from Anthropic.
      const providerKey = await seedOrgModelProviderKey({
        orgId: ctx.orgId,
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        apiKeyEncrypted: encrypt("sk-ant-oat-real-token-xyz"),
      });
      await seedOrgModel({
        orgId: ctx.orgId,
        providerKeyId: providerKey.id,
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        modelId: "claude-sonnet-4-6",
        label: "Sonnet OAuth",
      });

      const res = await app.request("/api/models", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ label: string; keyKind?: string | null }>;
      };
      const sonnet = body.data.find((m) => m.label === "Sonnet OAuth");
      expect(sonnet).toBeDefined();
      expect(sonnet!.keyKind).toBe("oauth");
    });

    it("flags Anthropic API-key credentials with keyKind='api-key'", async () => {
      const providerKey = await seedOrgModelProviderKey({
        orgId: ctx.orgId,
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        apiKeyEncrypted: encrypt("sk-ant-api03-real-key-xyz"),
      });
      await seedOrgModel({
        orgId: ctx.orgId,
        providerKeyId: providerKey.id,
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        modelId: "claude-sonnet-4-6",
        label: "Sonnet API Key",
      });

      const res = await app.request("/api/models", { headers: authHeaders(ctx) });
      const body = (await res.json()) as {
        data: Array<{ label: string; keyKind?: string | null }>;
      };
      const sonnet = body.data.find((m) => m.label === "Sonnet API Key");
      expect(sonnet!.keyKind).toBe("api-key");
    });

    it("returns keyKind=null for non-Anthropic protocols", async () => {
      const providerKey = await seedOrgModelProviderKey({
        orgId: ctx.orgId,
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEncrypted: encrypt("sk-openai-anything"),
      });
      await seedOrgModel({
        orgId: ctx.orgId,
        providerKeyId: providerKey.id,
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        modelId: "gpt-4o",
        label: "OpenAI Preset",
      });

      const res = await app.request("/api/models", { headers: authHeaders(ctx) });
      const body = (await res.json()) as {
        data: Array<{ label: string; keyKind?: string | null }>;
      };
      const openai = body.data.find((m) => m.label === "OpenAI Preset");
      // keyKind is Anthropic-only; other protocols MUST report null so
      // the CLI never tries to drive non-existent OAuth detection paths
      // for OpenAI/Mistral/etc.
      expect(openai!.keyKind ?? null).toBeNull();
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
