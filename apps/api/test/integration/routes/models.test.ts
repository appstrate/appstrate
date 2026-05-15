// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import {
  seedOrgModelProviderKey,
  seedOrgModel,
  seedOrgModelProviderOAuth,
} from "../../helpers/seed.ts";
import { db } from "@appstrate/db/client";
import { orgModels } from "@appstrate/db/schema";
import { eq, and } from "drizzle-orm";
import { TEST_OAUTH_PROVIDER_ID } from "../../helpers/test-oauth-provider.ts";

const app = getTestApp();

describe("Models API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  /** Helper: create a model provider key and return its ID (required for model creation). */
  async function createProviderKey(): Promise<string> {
    const res = await app.request("/api/model-provider-credentials", {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        label: "Test Model Provider Key",
        providerId: "openai",
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
      const credentialId = await createProviderKey();

      const res = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "GPT-4o",
          modelId: "gpt-4o",
          credentialId,
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.id).toBeDefined();
      expect(typeof body.id).toBe("string");
    });

    it("rejects non-UUID credentialId with 400 (built-in slugs like 'anthropic')", async () => {
      // System-key ids ("anthropic", "openai-prod", …) are slugs, not UUIDs —
      // they live in SYSTEM_PROVIDER_KEYS env and never appear in the
      // `model_provider_credentials` table. The UUID validator catches this
      // before the FK constraint does.
      const res = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Claude Haiku 4 5",
          modelId: "claude-haiku-4-5-20251001",
          credentialId: "anthropic",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { detail?: string };
      expect(body.detail).toContain("UUID");
    });
  });

  describe("DELETE /api/models/:id", () => {
    it("deletes a model and returns 204", async () => {
      const credentialId = await createProviderKey();

      // Create a model
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "To Delete",
          modelId: "gpt-4o-mini",
          credentialId,
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
      const credentialId = await createProviderKey();

      // Create a model first
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Default Model",
          modelId: "gpt-4o",
          credentialId,
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

  describe("POST /api/models/seed", () => {
    /**
     * Inserts an OAuth credential bound to the synthetic `test-oauth`
     * provider. The seed endpoint only accepts credentials whose providerId
     * matches a registered entry; the api-key-only `seedOrgModelProviderKey`
     * helper wouldn't suffice because its provider has no registered
     * `models[]` list.
     */
    async function seedTestOAuthCredential(): Promise<string> {
      const row = await seedOrgModelProviderOAuth({
        orgId: ctx.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        label: "Test OAuth",
        accessToken: "test-access",
        refreshToken: "test-refresh",
        expiresAt: null,
        createdBy: ctx.user.id,
      });
      return row.id;
    }

    it("seeds models atomically and promotes the first as default", async () => {
      const credentialId = await seedTestOAuthCredential();

      const res = await app.request("/api/models/seed", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ credentialId, modelIds: ["test-model"] }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        created: number;
        ids: string[];
        promotedDefault: boolean;
      };
      expect(body.created).toBe(1);
      expect(body.ids).toHaveLength(1);
      expect(body.promotedDefault).toBe(true);

      const inserted = await db
        .select()
        .from(orgModels)
        .where(and(eq(orgModels.orgId, ctx.orgId), eq(orgModels.credentialId, credentialId)));
      expect(inserted).toHaveLength(1);
      expect(inserted[0]!.modelId).toBe("test-model");
      expect(inserted[0]!.isDefault).toBe(true);
    });

    it("is idempotent — returns created=0 when models already exist for the credential", async () => {
      const credentialId = await seedTestOAuthCredential();

      const first = await app.request("/api/models/seed", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ credentialId, modelIds: ["test-model"] }),
      });
      expect(first.status).toBe(201);

      const second = await app.request("/api/models/seed", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ credentialId, modelIds: ["test-model"] }),
      });
      expect(second.status).toBe(201);
      const body = (await second.json()) as { created: number; promotedDefault: boolean };
      expect(body.created).toBe(0);
      expect(body.promotedDefault).toBe(false);
    });

    it("rejects unknown modelIds with 400", async () => {
      const credentialId = await seedTestOAuthCredential();

      const res = await app.request("/api/models/seed", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ credentialId, modelIds: ["does-not-exist"] }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 404 when the credential does not exist", async () => {
      const res = await app.request("/api/models/seed", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          credentialId: "00000000-0000-0000-0000-000000000000",
          modelIds: ["test-model"],
        }),
      });

      expect(res.status).toBe(404);
    });

    it("does NOT promote default when the org already has one", async () => {
      const existingKey = await seedOrgModelProviderKey({
        orgId: ctx.orgId,
        apiShape: "openai",
        baseUrl: "https://api.openai.com",
      });
      await seedOrgModel({
        orgId: ctx.orgId,
        credentialId: existingKey.id,
        modelId: "gpt-4o",
        label: "Existing default",
        isDefault: true,
      });

      const credentialId = await seedTestOAuthCredential();
      const res = await app.request("/api/models/seed", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ credentialId, modelIds: ["test-model"] }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { created: number; promotedDefault: boolean };
      expect(body.created).toBe(1);
      expect(body.promotedDefault).toBe(false);
    });
  });
});
