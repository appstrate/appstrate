// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  addOrgMember,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedOrgModelProviderKey,
  seedOrgModel,
  seedOrgModelProviderOAuth,
} from "../../helpers/seed.ts";
import { db } from "@appstrate/db/client";
import { orgModels, organizations } from "@appstrate/db/schema";
import { eq, and } from "drizzle-orm";
import { initSystemModelProviderKeys } from "../../../src/services/model-registry.ts";
import { TEST_OAUTH_PROVIDER_ID } from "../../helpers/test-oauth-provider.ts";
import { mintLoopbackToken } from "../../../../../packages/module-chat/src/loopback-auth.ts";

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

    it("strips the backing of a model alias from the list, but not from the create response (Threat A)", async () => {
      const credentialId = await createProviderKey();
      // A distinctive backing id so the security grep below is unambiguous.
      const realModelId = "secret-backing-zxq9";

      // Operator creates the alias — the create response is the full resource
      // (getOrgModel is NOT projected; the operator just configured it).
      const create = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Appstrate Medium",
          modelId: realModelId,
          credentialId,
          aliased: true,
        }),
      });
      expect(create.status).toBe(201);
      const created = (await create.json()) as any;
      expect(created.aliased).toBe(true);
      // Operator sees the real binding on the write response.
      expect(created.modelId).toBe(realModelId);

      // A dashboard user listing models gets the alias projected: the backing
      // is gone.
      const list = await app.request("/api/models", { headers: authHeaders(ctx) });
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as any;
      const row = listBody.data.find((m: any) => m.id === created.id);
      expect(row).toBeDefined();
      expect(row.aliased).toBe(true);
      expect(row.label).toBe("Appstrate Medium");
      expect(row.modelId).toBeNull();
      expect(row.apiShape).toBeNull();
      expect(row.baseUrl).toBeNull();
      expect(row.credentialId).toBeNull();
      expect(row.contextWindow).toBeNull();
      expect(row.cost).toBeNull();

      // Hard guarantee: the real upstream id never appears anywhere in the
      // user-facing list payload (mirrors the integration client-masking test).
      expect(JSON.stringify(listBody)).not.toContain(realModelId);
    });

    it("does NOT strip the alias backing for the first-party chat-loopback caller (chat routing)", async () => {
      // The chat needs the real apiShape/modelId to route an aliased model to
      // the right engine/proxy. The loopback is trusted server code — the
      // backing it reads never reaches the browser. See models.ts GET handler.
      const credentialId = await createProviderKey();
      const realModelId = "secret-backing-loopback-9q";
      const create = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Appstrate Medium",
          modelId: realModelId,
          credentialId,
          aliased: true,
        }),
      });
      expect(create.status).toBe(201);
      const created = (await create.json()) as any;

      const loopback = mintLoopbackToken({
        userId: ctx.user.id,
        email: ctx.user.email ?? "u@test",
        name: ctx.user.name ?? "U",
        orgId: ctx.orgId,
        orgRole: "owner",
      });
      const list = await app.request("/api/models", {
        headers: { Authorization: `Bearer ${loopback}`, "X-Org-Id": ctx.orgId },
      });
      expect(list.status).toBe(200);
      const row = ((await list.json()) as any).data.find((m: any) => m.id === created.id);
      expect(row).toBeDefined();
      expect(row.aliased).toBe(true);
      // Real binding is present for the loopback (so the chat can route it).
      expect(row.modelId).toBe(realModelId);
      expect(row.apiShape).not.toBeNull();
      expect(row.credentialId).toBe(credentialId);
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
      // Bare created resource (same shape as GET/list), not an id stub (#657).
      expect(body.id).toBeDefined();
      expect(typeof body.id).toBe("string");
      expect(body.label).toBe("GPT-4o");
      expect(body.modelId).toBe("gpt-4o");
      expect(body.credentialId).toBe(credentialId);
      expect(body.source).toBe("custom");
      expect(typeof body.enabled).toBe("boolean");
      expect(typeof body.is_default).toBe("boolean");
      expect(body.createdAt).toBeDefined();
      expect(body.updatedAt).toBeDefined();
    });

    it("defaults aliased to false and accepts aliased=true on create (round-trips to GET)", async () => {
      const credentialId = await createProviderKey();

      // Default: omitted → false.
      const plain = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ label: "Plain", modelId: "gpt-4o", credentialId }),
      });
      expect(plain.status).toBe(201);
      expect(((await plain.json()) as any).aliased).toBe(false);

      // Explicit alias.
      const aliased = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Appstrate Medium",
          modelId: "gpt-4o",
          credentialId,
          aliased: true,
        }),
      });
      expect(aliased.status).toBe(201);
      const created = (await aliased.json()) as any;
      expect(created.aliased).toBe(true);

      // Round-trips through the list.
      const list = await app.request("/api/models", { headers: authHeaders(ctx) });
      const row = ((await list.json()) as any).data.find((m: any) => m.id === created.id);
      expect(row.aliased).toBe(true);
    });

    it("rejects an aliased create with no explicit label (would leak the backing) — 400", async () => {
      const credentialId = await createProviderKey();
      const res = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        // No `label` — the derive-from-catalog fallback would name the alias
        // after its real backing, which survives the projection.
        body: JSON.stringify({ modelId: "gpt-4o", credentialId, aliased: true }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects an alias on a url-model protocol (the swap can't hide it) — 400", async () => {
      // google-generative-ai carries the model id in the URL path, not the
      // request body, so the body-`model` swap would never fire.
      const providerKey = await seedOrgModelProviderKey({
        orgId: ctx.orgId,
        apiShape: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.test",
        apiKey: "g-key",
      });
      const res = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Appstrate Large",
          modelId: "gemini-2.0-flash",
          credentialId: providerKey.id,
          aliased: true,
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects an alias on an oauth-subscription credential (bearer-swap-only path) — 400", async () => {
      // The oauth run path is a pure sidecar bearer-swap: no body rewrite
      // exists there, so an alias could neither be swapped nor masked.
      const row = await seedOrgModelProviderOAuth({
        orgId: ctx.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        label: "Test OAuth",
        accessToken: "test-access",
        refreshToken: "test-refresh",
        expiresAt: null,
        createdBy: ctx.user.id,
      });
      const res = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Appstrate Subscribed",
          modelId: "test-model",
          credentialId: row.id,
          aliased: true,
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { detail?: string };
      expect(String(body.detail)).toContain("oauth-subscription");
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

    it("rejects maxTokens >= contextWindow with 400 (canonical model invariant)", async () => {
      // `input + output <= context`, so a response cap can never reach the
      // full window. The edge guard rejects the impossible override before it
      // reaches the runtime (where it would crash the sidecar / pin the
      // compaction threshold at zero).
      const credentialId = await createProviderKey();
      const res = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Bogus",
          modelId: "bogus-model",
          credentialId,
          contextWindow: 256_000,
          maxTokens: 256_000,
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects a needs-reconnection credential with 400 before inserting (explicit label path)", async () => {
      // Regression for the hoisted reachability gate: with an explicit label,
      // the old code skipped `loadInferenceCredentials` entirely, inserted the
      // row, then 500'd on the bare-resource re-projection (the list
      // serializer filters models bound to unreachable credentials) — leaving
      // a phantom row the caller could never see.
      const dead = await seedOrgModelProviderOAuth({
        orgId: ctx.orgId,
        needsReconnection: true,
      });

      const res = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Phantom",
          modelId: "gpt-4o",
          credentialId: dead.id,
        }),
      });

      expect(res.status).toBe(400);
      const body400 = (await res.json()) as { detail?: string };
      expect(body400.detail).toContain("unreachable");

      // No phantom row inserted.
      const rows = await db
        .select()
        .from(orgModels)
        .where(and(eq(orgModels.orgId, ctx.orgId), eq(orgModels.label, "Phantom")));
      expect(rows).toHaveLength(0);
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

    it("clears the org default pointer when the default model is deleted", async () => {
      const credentialId = await createProviderKey();
      // First model for the org auto-promotes to the default (pointer set).
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ label: "Default", modelId: "gpt-4o", credentialId }),
      });
      const { id } = (await createRes.json()) as any;

      const [before] = await db
        .select({ defaultModelId: organizations.defaultModelId })
        .from(organizations)
        .where(eq(organizations.id, ctx.orgId))
        .limit(1);
      expect(before!.defaultModelId).toBe(id);

      // Deleting the default clears the now-dangling pointer (no stale badge).
      const del = await app.request(`/api/models/${id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });
      expect(del.status).toBe(204);

      const [after] = await db
        .select({ defaultModelId: organizations.defaultModelId })
        .from(organizations)
        .where(eq(organizations.id, ctx.orgId))
        .limit(1);
      expect(after!.defaultModelId).toBeNull();
    });
  });

  describe("PUT /api/models/:id", () => {
    it("updates a model and returns the full updated resource", async () => {
      const credentialId = await createProviderKey();

      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Before",
          modelId: "gpt-4o",
          credentialId,
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as any;

      const res = await app.request(`/api/models/${id}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ label: "After", enabled: false }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // Bare updated resource (#657).
      expect(body.id).toBe(id);
      expect(body.label).toBe("After");
      expect(body.enabled).toBe(false);
      expect(body.source).toBe("custom");
    });

    it("rejects switching to a needs-reconnection credential with 400, model unchanged", async () => {
      // Regression for the PUT-side reachability gate: re-pointing a model to
      // a dead credential used to let the UPDATE land, then the bare-resource
      // re-read 404'd ("Model not found" after a write that DID succeed).
      const credentialId = await createProviderKey();
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Stable",
          modelId: "gpt-4o",
          credentialId,
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      const dead = await seedOrgModelProviderOAuth({
        orgId: ctx.orgId,
        needsReconnection: true,
      });

      const res = await app.request(`/api/models/${id}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ credentialId: dead.id }),
      });

      expect(res.status).toBe(400);
      const body400 = (await res.json()) as { detail?: string };
      expect(body400.detail).toContain("unreachable");

      // The write was rejected before landing — credential pointer unchanged.
      const [row] = await db.select().from(orgModels).where(eq(orgModels.id, id));
      expect(row!.credentialId).toBe(credentialId);
    });

    it("rejects flipping aliased on an oauth-subscription model — PUT enforces the same invariants as POST", async () => {
      // Regression: PUT used to write `data` (incl. `aliased`) with no
      // invariant check, so a non-aliased oauth model could become aliased by
      // update — a state POST rejects, caught only late at run launch.
      const oauth = await seedOrgModelProviderOAuth({
        orgId: ctx.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        label: "Test OAuth",
        accessToken: "test-access",
        refreshToken: "test-refresh",
        expiresAt: null,
        createdBy: ctx.user.id,
      });
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Subscribed",
          modelId: "test-model",
          credentialId: oauth.id,
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      const res = await app.request(`/api/models/${id}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ aliased: true, label: "Masked" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { detail?: string };
      expect(String(body.detail)).toContain("oauth-subscription");

      const [row] = await db.select().from(orgModels).where(eq(orgModels.id, id));
      expect(row!.aliased).toBe(false);
    });

    it("rejects flipping aliased without a fresh explicit label — the stored label may name the backing", async () => {
      const credentialId = await createProviderKey();
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        // No label → derived from the catalog (names the backing model).
        body: JSON.stringify({ modelId: "gpt-4o", credentialId }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      // Flip without a label — rejected (the derived label would leak).
      const noLabel = await app.request(`/api/models/${id}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ aliased: true }),
      });
      expect(noLabel.status).toBe(400);
      const body = (await noLabel.json()) as { detail?: string };
      expect(String(body.detail)).toContain("label");

      // Same flip with an explicit label — accepted (api-key, body-model shape).
      const withLabel = await app.request(`/api/models/${id}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ aliased: true, label: "Appstrate Medium" }),
      });
      expect(withLabel.status).toBe(200);
    });

    it("rejects re-pointing an aliased model to an oauth-subscription credential", async () => {
      const credentialId = await createProviderKey();
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Appstrate Medium",
          modelId: "gpt-4o",
          credentialId,
          aliased: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      const oauth = await seedOrgModelProviderOAuth({
        orgId: ctx.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        label: "Test OAuth",
        accessToken: "test-access",
        refreshToken: "test-refresh",
        expiresAt: null,
        createdBy: ctx.user.id,
      });
      const res = await app.request(`/api/models/${id}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ credentialId: oauth.id }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { detail?: string };
      expect(String(body.detail)).toContain("oauth-subscription");

      const [row] = await db.select().from(orgModels).where(eq(orgModels.id, id));
      expect(row!.credentialId).toBe(credentialId);
    });

    it("updates an already-aliased model without re-sending the label (explicit by construction)", async () => {
      const credentialId = await createProviderKey();
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Appstrate Medium",
          modelId: "gpt-4o",
          credentialId,
          aliased: true,
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      const res = await app.request(`/api/models/${id}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { enabled?: boolean; label?: string };
      expect(body.enabled).toBe(false);
      expect(body.label).toBe("Appstrate Medium");
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
      // Bare effective default model resource — no `success` envelope (#657).
      expect(body.success).toBeUndefined();
      expect(body.id).toBe(id);
      expect(body.is_default).toBe(true);
      expect(body.label).toBe("Default Model");
      expect(body.modelId).toBe("gpt-4o");
    });

    it("returns 204 when clearing the default and none remains in effect", async () => {
      const res = await app.request("/api/models/default", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ modelId: null }),
      });

      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    });
  });

  // The org default is an org-level pointer that may name a SYSTEM model id (not
  // just a custom row) — picking any entry, system or custom, makes exactly that
  // one the default ("set default takes over"). Inject a system model into the
  // shared module-static registry for these tests and restore the empty test
  // baseline afterwards so it never leaks into other suites.
  describe("PUT /api/models/default — system model (pointer takes over)", () => {
    const SYSTEM_MODEL_ID = "sys-model-default-test";

    beforeEach(() => {
      initSystemModelProviderKeys([
        {
          id: "sys-key-default-test",
          providerId: "openai",
          apiKey: "sk-system-test",
          models: [{ id: SYSTEM_MODEL_ID, modelId: "gpt-4o" }],
        },
      ]);
    });
    afterEach(() => {
      initSystemModelProviderKeys(); // restore empty baseline (env is empty in test)
    });

    it("sets a system model as the org default and persists the pointer", async () => {
      const res = await app.request("/api/models/default", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ modelId: SYSTEM_MODEL_ID }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe(SYSTEM_MODEL_ID);
      expect(body.is_default).toBe(true);
      expect(body.source).toBe("built-in");

      const [org] = await db
        .select({ defaultModelId: organizations.defaultModelId })
        .from(organizations)
        .where(eq(organizations.id, ctx.orgId))
        .limit(1);
      expect(org!.defaultModelId).toBe(SYSTEM_MODEL_ID);

      // Exactly one default in the list, and it's the system model.
      const list = await app.request("/api/models", { headers: authHeaders(ctx) });
      const models = ((await list.json()) as any).data as any[];
      const defaults = models.filter((m) => m.is_default);
      expect(defaults).toHaveLength(1);
      expect(defaults[0]!.id).toBe(SYSTEM_MODEL_ID);
    });

    it("a system default takes over from an existing custom default", async () => {
      // First custom model auto-promotes to default.
      const credentialId = await createProviderKey();
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ label: "Custom", modelId: "gpt-4o-mini", credentialId }),
      });
      const { id: customId } = (await createRes.json()) as any;

      // Switch the default to the system model — it takes over.
      const res = await app.request("/api/models/default", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ modelId: SYSTEM_MODEL_ID }),
      });
      expect(res.status).toBe(200);

      const list = await app.request("/api/models", { headers: authHeaders(ctx) });
      const models = ((await list.json()) as any).data as any[];
      expect(models.find((m) => m.id === SYSTEM_MODEL_ID)?.is_default).toBe(true);
      expect(models.find((m) => m.id === customId)?.is_default).toBe(false);
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
      // The default is the org-level pointer, not a per-row flag: the first
      // seeded model is now `organizations.default_model_id`.
      const [org] = await db
        .select({ defaultModelId: organizations.defaultModelId })
        .from(organizations)
        .where(eq(organizations.id, ctx.orgId))
        .limit(1);
      expect(org!.defaultModelId).toBe(inserted[0]!.id);
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
      const existing = await seedOrgModel({
        orgId: ctx.orgId,
        credentialId: existingKey.id,
        modelId: "gpt-4o",
        label: "Existing default",
      });
      // The org default is the pointer — point it at the existing model.
      await db
        .update(organizations)
        .set({ defaultModelId: existing.id })
        .where(eq(organizations.id, ctx.orgId));

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

  // FINDING B2: the connection-test routes load a credential and can spend a
  // subscription credential, so they must require `models:write` like their
  // siblings — not just be rate-limited. The `member` role has `models:read`
  // but NOT `models:write`, so it is the right negative case.
  describe("connection-test routes require models:write", () => {
    /** Member-role headers in the owner's org (member lacks models:write). */
    async function memberHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
      const member = await createTestUser({});
      await addOrgMember(ctx.orgId, member.id, "member");
      return {
        Cookie: member.cookie,
        "X-Org-Id": ctx.orgId,
        "X-Application-Id": ctx.defaultAppId,
        ...extra,
      };
    }

    it("POST /api/models/test → 403 for a member (no models:write)", async () => {
      const key = await seedOrgModelProviderKey({
        orgId: ctx.orgId,
        apiShape: "openai",
        baseUrl: "https://api.openai.com",
      });
      const res = await app.request("/api/models/test", {
        method: "POST",
        headers: await memberHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ credentialId: key.id, modelId: "gpt-4o", apiKey: "sk-test" }),
      });
      expect(res.status).toBe(403);
    });

    it("POST /api/models/:id/test → 403 for a member (no models:write)", async () => {
      const key = await seedOrgModelProviderKey({
        orgId: ctx.orgId,
        apiShape: "openai",
        baseUrl: "https://api.openai.com",
      });
      const model = await seedOrgModel({
        orgId: ctx.orgId,
        credentialId: key.id,
        modelId: "gpt-4o",
        label: "Member test model",
      });
      const res = await app.request(`/api/models/${model.id}/test`, {
        method: "POST",
        headers: await memberHeaders(),
      });
      expect(res.status).toBe(403);
    });

    it("POST /api/models/test → not 403 for an owner (has models:write)", async () => {
      const key = await seedOrgModelProviderKey({
        orgId: ctx.orgId,
        apiShape: "openai",
        baseUrl: "https://api.openai.com",
      });
      const res = await app.request("/api/models/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ credentialId: key.id, modelId: "gpt-4o", apiKey: "sk-test" }),
      });
      // The owner passes the permission guard; the body may then succeed or
      // surface a provider error, but it is never an authorization failure.
      expect(res.status).not.toBe(403);
    });
  });
});
