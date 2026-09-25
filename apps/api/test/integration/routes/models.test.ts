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
import { modelProviderCredentials, orgModels, organizations } from "@appstrate/db/schema";
import { eq, and } from "drizzle-orm";
import { initSystemModelProviderKeys } from "../../../src/services/model-registry.ts";
import { listCatalogModels, lookupCatalogModel } from "../../../src/services/model-catalog.ts";
import { getModelProvider } from "../../../src/services/model-providers/registry.ts";
import { TEST_OAUTH_MODEL_ID, TEST_OAUTH_PROVIDER_ID } from "../../helpers/test-oauth-provider.ts";
import { mintLoopbackToken } from "../../../../../packages/module-chat/src/loopback-auth.ts";

const app = getTestApp();

// ─── OpenRouter catalog stub ──────────────────────────────
// `GET /api/models/openrouter` proxies openrouter.ai through `globalThis.fetch`
// (no DI seam at the route boundary). Pin the REAL fetch once at module load —
// re-capturing it inside the helper would snapshot a stub as the "original" and
// leak the override into unrelated tests.
const realFetch: typeof fetch = globalThis.fetch;
function mockOpenRouterCatalog(data: unknown[]): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}
function restoreFetch(): void {
  if (realFetch) globalThis.fetch = realFetch;
}

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
        api_key: "sk-test-key-123",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    return body.id;
  }

  /**
   * Helper: a credential on a user-described gateway, which takes any model id
   * (a named provider takes only the ids of its catalog offer).
   */
  async function createGatewayKey(): Promise<string> {
    const res = await app.request("/api/model-provider-credentials", {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        label: "Test Gateway Key",
        providerId: "openai-compatible",
        api_key: "sk-test-key-123",
        base_url_override: "https://gateway.example.test/v1",
      }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
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
      const credentialId = await createGatewayKey();
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
      expect(row.base_url).toBeNull();
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
      const credentialId = await createGatewayKey();
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

    it("exposes `pi_provider` — the Pi key of the credential's provider, null for a gateway, withheld for an alias", async () => {
      const [kimi, kimiAlias] = listCatalogModels(getModelProvider("moonshot")!).map((m) => m.id);
      const moonshot = await seedOrgModelProviderKey({ orgId: ctx.orgId, providerId: "moonshot" });
      const named = await seedOrgModel({
        orgId: ctx.orgId,
        credentialId: moonshot.id,
        modelId: kimi!,
      });
      const alias = await seedOrgModel({
        orgId: ctx.orgId,
        credentialId: moonshot.id,
        modelId: kimiAlias!,
        label: "Managed",
        aliased: true,
      });
      const gateway = await seedOrgModel({
        orgId: ctx.orgId,
        credentialId: await createGatewayKey(),
        modelId: "any-gateway-model",
      });
      const rowsOf = async (headers: Record<string, string>) => {
        const res = await app.request("/api/models", { headers });
        expect(res.status).toBe(200);
        const data = ((await res.json()) as any).data as any[];
        return (id: string) => data.find((m) => m.id === id);
      };

      const projected = await rowsOf(authHeaders(ctx));
      expect(projected(named.id).pi_provider).toBe("moonshotai");
      expect(projected(gateway.id).pi_provider).toBeNull();
      expect(projected(alias.id).pi_provider).toBeNull();

      const loopback = mintLoopbackToken({
        userId: ctx.user.id,
        email: ctx.user.email ?? "u@test",
        name: ctx.user.name ?? "U",
        orgId: ctx.orgId,
        orgRole: "owner",
      });
      const firstParty = await rowsOf({
        Authorization: `Bearer ${loopback}`,
        "X-Org-Id": ctx.orgId,
      });
      expect(firstParty(alias.id).pi_provider).toBe("moonshotai");
    });
  });

  describe("GET /api/models/openrouter", () => {
    afterEach(() => {
      restoreFetch();
    });

    it("omits a cache rate OpenRouter does not report instead of fabricating a 0 (#1042)", async () => {
      mockOpenRouterCatalog([
        {
          id: "vendor/with-cache-read",
          name: "With cache read",
          pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" },
        },
        {
          id: "vendor/without-cache-read",
          name: "Without cache read",
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
      ]);

      const res = await app.request("/api/models/openrouter", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      const withCacheRead = body.data.find((m: any) => m.id === "vendor/with-cache-read");
      expect(withCacheRead.cost.input).toBeCloseTo(3);
      expect(withCacheRead.cost.output).toBeCloseTo(15);
      expect(withCacheRead.cost.cacheRead).toBeCloseTo(0.3);

      // The whole point of #1042: the key must be ABSENT, not `undefined`-ish.
      // `classifyTokenPricing` tests `cost.cacheRead == null`, and an explicit
      // `0` reads as a real vendor price — so a fabricated zero would stamp an
      // unpriceable model `priced` and silently drop its cached tokens.
      const withoutCacheRead = body.data.find((m: any) => m.id === "vendor/without-cache-read");
      expect(withoutCacheRead.cost.input).toBeCloseTo(1);
      expect(withoutCacheRead.cost.output).toBeCloseTo(2);
      expect("cacheRead" in withoutCacheRead.cost).toBe(false);

      // `cacheWrite` is never reported by this endpoint — it is never invented
      // for either entry.
      expect("cacheWrite" in withCacheRead.cost).toBe(false);
      expect("cacheWrite" in withoutCacheRead.cost).toBe(false);
    });

    it("returns a null cost when prompt/completion pricing is missing", async () => {
      mockOpenRouterCatalog([
        { id: "vendor/unpriced", name: "Unpriced", pricing: { completion: "0.000002" } },
      ]);

      const res = await app.request("/api/models/openrouter", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data.find((m: any) => m.id === "vendor/unpriced").cost).toBeNull();
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

    it("rejects an input modality the runtime cannot boot with — 400, nothing stored", async () => {
      const credentialId = await createProviderKey();
      const res = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ modelId: "gpt-4o", credentialId, input: ["text", "audio"] }),
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      const body = (await res.json()) as { errors?: { field: string }[] };
      expect(body.errors?.map((e) => e.field)).toContain("input[1]");
      const rows = await db.select().from(orgModels).where(eq(orgModels.orgId, ctx.orgId));
      expect(rows).toHaveLength(0);
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
          modelId: TEST_OAUTH_MODEL_ID,
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

    it("rejects a lone maxTokens override that exceeds the catalog contextWindow (effective state)", async () => {
      // The Zod refine only fires when both fields ride together. An omitted
      // contextWindow falls back to the live catalog at read/run time, so the
      // effective pairing must be checked against the catalog value.
      const credentialId = await createProviderKey();
      const catalogModel = listCatalogModels(getModelProvider("openai")!).find(
        (m) => m.contextWindow != null,
      )!;

      const res = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Over Budget",
          modelId: catalogModel.id,
          credentialId,
          maxTokens: catalogModel.contextWindow,
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { detail?: string };
      expect(body.detail).toContain("contextWindow");
    });

    it("refuses a model outside a named provider's catalog offer", async () => {
      const credentialId = await createProviderKey();
      const res = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ label: "Unknown", modelId: "no-such-catalog-model", credentialId }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { detail?: string }).detail).toContain("not offered");
    });

    it("accepts a lone maxTokens for a gateway model unknown to the catalog (nothing to compare)", async () => {
      const credentialId = await createGatewayKey();
      const res = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Uncatalogued",
          modelId: "no-such-catalog-model-zq7",
          credentialId,
          maxTokens: 10_000_000,
        }),
      });
      expect(res.status).toBe(201);
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

    // Issue #1358 — `llm_usage.model` stores the org_models row id, so a second
    // row for the same (credential, model) pair splits that model's spend
    // across the copies. `uq_org_models_unaliased_binding` is what refuses
    // it; only the LABEL was deduped before, which is not the invariant.
    it("refuses a second model for the same credential and model id", async () => {
      const credentialId = await createProviderKey();
      const body = JSON.stringify({ modelId: "gpt-4o", credentialId });

      const first = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body,
      });
      expect(first.status).toBe(201);
      const created = (await first.json()) as any;

      const second = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body,
      });

      expect(second.status).toBe(409);
      const problem = (await second.json()) as any;
      expect(problem.code).toBe("model_already_added");
      // The row that already holds the binding, so the caller can act on it.
      expect(problem.existing_model_id).toBe(created.id);

      const rows = await db
        .select()
        .from(orgModels)
        .where(and(eq(orgModels.orgId, ctx.orgId), eq(orgModels.modelId, "gpt-4o")));
      expect(rows).toHaveLength(1);
    });

    // The index is partial: an alias is a deliberate public identity over a
    // backing model, so it may share a binding with the direct row.
    it("still allows a managed (aliased) model over an already-added binding", async () => {
      const credentialId = await createProviderKey();
      const plain = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ modelId: "gpt-4o", credentialId }),
      });
      expect(plain.status).toBe(201);

      const alias = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Appstrate Medium",
          modelId: "gpt-4o",
          credentialId,
          aliased: true,
        }),
      });
      expect(alias.status).toBe(201);
    });

    it("still allows the same model id against a different credential", async () => {
      const first = await createProviderKey();
      const second = await createProviderKey();

      for (const credentialId of [first, second]) {
        const res = await app.request("/api/models", {
          method: "POST",
          headers: authHeaders(ctx, { "Content-Type": "application/json" }),
          body: JSON.stringify({ modelId: "gpt-4o", credentialId }),
        });
        expect(res.status).toBe(201);
      }
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

  describe("PATCH /api/models/:id", () => {
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
        method: "PATCH",
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

    // Since #1040 removed the dashboard's pricing inputs, PUT is the ONLY way a
    // human sets or clears a cost override. These three pin that escape hatch:
    // `buildUpdateSet` skips `undefined` but writes `null`, so an explicit null
    // clears back to the catalog while an omitted key preserves the override.
    it("stores a cost override sent through PUT", async () => {
      const credentialId = await createProviderKey();
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ label: "Priced", modelId: "gpt-4o", credentialId }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      const res = await app.request(`/api/models/${id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ cost: { input: 3, output: 15 } }),
      });
      expect(res.status).toBe(200);

      const [row] = await db.select().from(orgModels).where(eq(orgModels.id, id));
      expect(row!.cost).toEqual({ input: 3, output: 15 });
    });

    it("clears a cost override back to the catalog with an explicit null", async () => {
      const credentialId = await createProviderKey();
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Priced",
          modelId: "gpt-4o",
          credentialId,
          cost: { input: 3, output: 15 },
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      const res = await app.request(`/api/models/${id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ cost: null }),
      });
      expect(res.status).toBe(200);

      const [row] = await db.select().from(orgModels).where(eq(orgModels.id, id));
      expect(row!.cost).toBeNull();
    });

    it("leaves an existing cost override intact when PUT does not mention cost", async () => {
      const credentialId = await createProviderKey();
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Priced",
          modelId: "gpt-4o",
          credentialId,
          cost: { input: 3, output: 15 },
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      const res = await app.request(`/api/models/${id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ label: "Renamed" }),
      });
      expect(res.status).toBe(200);

      const [row] = await db.select().from(orgModels).where(eq(orgModels.id, id));
      expect(row!.label).toBe("Renamed");
      expect(row!.cost).toEqual({ input: 3, output: 15 });
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
        method: "PATCH",
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
          modelId: TEST_OAUTH_MODEL_ID,
          credentialId: oauth.id,
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      const res = await app.request(`/api/models/${id}`, {
        method: "PATCH",
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
        method: "PATCH",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ aliased: true }),
      });
      expect(noLabel.status).toBe(400);
      const body = (await noLabel.json()) as { detail?: string };
      expect(String(body.detail)).toContain("label");

      // Same flip with an explicit label — accepted (api-key, body-model shape).
      const withLabel = await app.request(`/api/models/${id}`, {
        method: "PATCH",
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
        method: "PATCH",
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
        method: "PATCH",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { enabled?: boolean; label?: string };
      expect(body.enabled).toBe(false);
      expect(body.label).toBe("Appstrate Medium");
    });

    it("rejects a lone maxTokens that meets or exceeds the stored contextWindow override", async () => {
      // The Zod refine only sees the payload — the effective pairing is
      // stored-override vs new-override.
      const credentialId = await createGatewayKey();
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Budgeted",
          modelId: "no-such-catalog-model-b1",
          credentialId,
          contextWindow: 100_000,
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      const res = await app.request(`/api/models/${id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ maxTokens: 100_000 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { detail?: string };
      expect(body.detail).toContain("contextWindow");

      // Rejected before landing — no override stored.
      const [row] = await db.select().from(orgModels).where(eq(orgModels.id, id));
      expect(row!.maxTokens).toBeNull();
    });

    it("rejects a lone contextWindow that dips below the stored maxTokens override, accepts a valid one", async () => {
      const credentialId = await createGatewayKey();
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Shrinking",
          modelId: "no-such-catalog-model-b2",
          credentialId,
          contextWindow: 100_000,
          maxTokens: 50_000,
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      const reject = await app.request(`/api/models/${id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ contextWindow: 50_000 }),
      });
      expect(reject.status).toBe(400);

      const accept = await app.request(`/api/models/${id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ contextWindow: 60_000 }),
      });
      expect(accept.status).toBe(200);
    });

    it("rejects a modelId change that swaps the catalog under a kept maxTokens override", async () => {
      // The row's maxTokens is valid against gpt-5.5's window; re-pointing
      // modelId at gpt-4o pairs that kept override with a smaller window.
      const credentialId = await createProviderKey();
      const openai = getModelProvider("openai")!;
      const wide = lookupCatalogModel(openai, "gpt-5.5")!;
      const narrow = lookupCatalogModel(openai, "gpt-4o")!;
      const maxTokens = narrow.contextWindow;
      expect(maxTokens).toBeLessThan(wide.contextWindow);
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ label: "Repointed", modelId: "gpt-5.5", credentialId, maxTokens }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      const res = await app.request(`/api/models/${id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ modelId: "gpt-4o" }),
      });
      expect(res.status).toBe(400);

      // Rejected before landing — modelId unchanged.
      const [row] = await db.select().from(orgModels).where(eq(orgModels.id, id));
      expect(row!.modelId).toBe("gpt-5.5");
    });

    it("refuses a modelId change to an id outside the provider's offer", async () => {
      const credentialId = await createProviderKey();
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ label: "Offered", modelId: "gpt-5.5", credentialId }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      const res = await app.request(`/api/models/${id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ modelId: "no-such-catalog-model" }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { detail?: string }).detail).toContain("not offered");
    });

    it("refuses a credentialId change that rebinds the model outside the new provider's offer", async () => {
      const gatewayKey = await createGatewayKey();
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Local",
          modelId: "my-local-model",
          credentialId: gatewayKey,
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      const res = await app.request(`/api/models/${id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ credentialId: await createProviderKey() }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { detail?: string }).detail).toContain("not offered");
      const [row] = await db.select().from(orgModels).where(eq(orgModels.id, id));
      expect(row!.credentialId).toBe(gatewayKey);
    });

    it("rejects clearing a contextWindow override when the catalog fallback violates the kept maxTokens", async () => {
      // `contextWindow: null` clears the override — the effective value falls
      // back to the live catalog, which must still beat the kept maxTokens.
      const credentialId = await createProviderKey();
      const catalogModel = listCatalogModels(getModelProvider("openai")!).find(
        (m) => m.contextWindow != null,
      )!;
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Cleared",
          modelId: catalogModel.id,
          credentialId,
          contextWindow: 10_000_000,
          maxTokens: catalogModel.contextWindow,
        }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      const res = await app.request(`/api/models/${id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ contextWindow: null }),
      });
      expect(res.status).toBe(400);
    });

    it("projects a model alias on the update response — parity with the list (Threat A)", async () => {
      const credentialId = await createGatewayKey();
      // A distinctive backing id so the payload grep below is unambiguous.
      const realModelId = "secret-backing-put-7k4v";

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

      // A no-op update: the caller supplies NOTHING about the binding. This is
      // what separates PUT from POST — the create response may echo the
      // binding back because the operator just sent it in the request body,
      // but an `{ enabled }` update discloses fields the caller never had.
      const put = await app.request(`/api/models/${created.id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ enabled: true }),
      });
      expect(put.status).toBe(200);
      const updated = (await put.json()) as any;

      // The update response must hide exactly what the list response hides.
      const list = await app.request("/api/models", { headers: authHeaders(ctx) });
      const listRow = (((await list.json()) as any).data as any[]).find((m) => m.id === created.id);
      expect(listRow).toBeDefined();
      for (const field of [
        "apiShape",
        "providerId",
        "provider_name",
        "base_url",
        "modelId",
        "credentialId",
        "contextWindow",
        "maxTokens",
        "cost",
      ]) {
        expect(listRow[field]).toBeNull();
        expect(updated[field]).toBeNull();
      }

      // The alias identity itself still round-trips — projection, not erasure.
      expect(updated.id).toBe(created.id);
      expect(updated.label).toBe("Appstrate Medium");
      expect(updated.aliased).toBe(true);
      expect(updated.enabled).toBe(true);

      // Hard guarantee: the real upstream id never appears anywhere in the
      // update payload (mirrors the list-projection test above).
      expect(JSON.stringify(updated)).not.toContain(realModelId);
    });

    // The same invariant on the edit path: repointing a row onto a binding
    // another row already holds is the same duplicate, reached sideways.
    it("refuses an edit that would collide with another row's binding", async () => {
      const credentialId = await createProviderKey();
      const mine = await seedOrgModel({ orgId: ctx.orgId, credentialId, modelId: "gpt-4o" });
      const other = await seedOrgModel({
        orgId: ctx.orgId,
        credentialId,
        modelId: "gpt-4o-mini",
      });

      const res = await app.request(`/api/models/${other.id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ modelId: "gpt-4o" }),
      });

      expect(res.status).toBe(409);
      const problem = (await res.json()) as any;
      expect(problem.code).toBe("model_already_added");
      expect(problem.existing_model_id).toBe(mine.id);
    });

    it("rejects an input modality the runtime cannot boot with — 400, row unchanged", async () => {
      const credentialId = await createProviderKey();
      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ label: "Vision", modelId: "gpt-4o", credentialId, input: ["text"] }),
      });
      expect(createRes.status).toBe(201);
      const { id } = (await createRes.json()) as { id: string };

      const res = await app.request(`/api/models/${id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ input: ["video"] }),
      });
      expect(res.status).toBe(400);
      const [row] = await db.select().from(orgModels).where(eq(orgModels.id, id));
      expect(row!.input).toEqual(["text"]);
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

  describe("OAuth Test action", () => {
    afterEach(() => restoreFetch());

    it("flags an expired saved credential when its refresh token is revoked", async () => {
      const credential = await seedOrgModelProviderOAuth({
        orgId: ctx.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        accessToken: "expired-access-token",
        refreshToken: "revoked-refresh-token",
        expiresAt: Date.now() - 60_000,
      });
      const model = await seedOrgModel({
        orgId: ctx.orgId,
        credentialId: credential.id,
        label: "Gpt (codex)",
        modelId: TEST_OAUTH_MODEL_ID,
      });

      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "refresh token revoked",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch;

      const tested = await app.request(`/api/models/${model.id}/test`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(tested.status).toBe(200);
      expect(await tested.json()).toMatchObject({
        ok: false,
        error: "NEEDS_RECONNECTION",
      });

      const credentialsResponse = await app.request("/api/model-provider-credentials", {
        headers: authHeaders(ctx),
      });
      const credentials = (await credentialsResponse.json()) as {
        data: Array<{ id: string; needs_reconnection: boolean }>;
      };
      expect(credentials.data.find((row) => row.id === credential.id)?.needs_reconnection).toBe(
        true,
      );

      const modelsResponse = await app.request("/api/models", { headers: authHeaders(ctx) });
      const models = (await modelsResponse.json()) as {
        data: Array<{ id: string; needs_reconnection: boolean }>;
      };
      expect(models.data.find((row) => row.id === model.id)?.needs_reconnection).toBe(true);
    });
  });

  /**
   * The production deadlock, walked end to end over HTTP.
   *
   * `listOrgModels` used to DROP a model whose credential could no longer serve
   * inference, while `org_models.credential_id` (ON DELETE RESTRICT) kept that
   * credential undeletable: the model was invisible, so it could not be
   * detached, so the credential could not be deleted. The service-level tests
   * pin the serializer; only these pin the sequence a user actually performs —
   * in particular the final credential DELETE, without which a future
   * reachability guard on `DELETE /api/models/:id` would reinstate the
   * deadlock with the whole suite green.
   */
  describe("dead credential — end-to-end recovery over HTTP", () => {
    /** A `needsReconnection` OAuth credential with one enabled model bound to it. */
    async function seedDeadPair(label: string) {
      const cred = await seedOrgModelProviderOAuth({
        orgId: ctx.orgId,
        providerId: TEST_OAUTH_PROVIDER_ID,
        label: `${label} credential`,
        needsReconnection: true,
      });
      const model = await seedOrgModel({
        orgId: ctx.orgId,
        credentialId: cred.id,
        label,
        modelId: "gpt-4o",
        enabled: true,
      });
      return { cred, model };
    }

    it("lists the dead model, detaches it, then deletes the credential (204, not 409 credential_in_use)", async () => {
      const { cred, model } = await seedDeadPair("Dead model");

      // 1. It surfaces on GET — through the real serializer + alias projection.
      const list = await app.request("/api/models", { headers: authHeaders(ctx) });
      expect(list.status).toBe(200);
      const listed = ((await list.json()) as any).data.find((m: any) => m.id === model.id);
      expect(listed).toBeDefined();
      expect(listed.needs_reconnection).toBe(true);

      // 2. …so it can be detached,
      const delModel = await app.request(`/api/models/${model.id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });
      expect(delModel.status).toBe(204);

      // 3. …which releases the FK. This is the 409 the user could never escape.
      const delCred = await app.request(`/api/model-provider-credentials/${cred.id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });
      expect(delCred.status).toBe(204);
    });

    it("refuses a dead model as the org default — 409 model_needs_reconnection", async () => {
      const { model } = await seedDeadPair("Dead default candidate");

      const res = await app.request("/api/models/default", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ modelId: model.id }),
      });

      expect(res.status).toBe(409);
      expect(((await res.json()) as any).code).toBe("model_needs_reconnection");

      const [org] = await db
        .select({ defaultModelId: organizations.defaultModelId })
        .from(organizations)
        .where(eq(organizations.id, ctx.orgId))
        .limit(1);
      expect(org!.defaultModelId).toBeNull();
    });

    it("still accepts a model whose credential's providerId is unregistered", async () => {
      // NOT a 409: the credential is healthy — its provider module was dropped
      // from `MODULES`, which is why the model is absent from GET /api/models
      // in the first place. "Reconnect this credential" would be misdirection
      // about a row the client cannot even see; the fix is to restore the
      // module. So this behaves exactly as it did before the flag existed.
      const { cred, model } = await seedDeadPair("Orphaned provider");
      await db
        .update(modelProviderCredentials)
        .set({ providerId: "@gone/provider" })
        .where(eq(modelProviderCredentials.id, cred.id));

      const list = await app.request("/api/models", { headers: authHeaders(ctx) });
      expect(((await list.json()) as any).data.find((m: any) => m.id === model.id)).toBeUndefined();

      const res = await app.request("/api/models/default", {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ modelId: model.id }),
      });
      // 204, not 200: the write lands, but the handler re-reads the list to
      // echo the effective default and the row is not in it. Pre-existing
      // shape, unchanged by this branch — the assertion of record is the
      // stored pointer below.
      expect(res.status).toBe(204);

      const [org] = await db
        .select({ defaultModelId: organizations.defaultModelId })
        .from(organizations)
        .where(eq(organizations.id, ctx.orgId))
        .limit(1);
      expect(org!.defaultModelId).toBe(model.id);
    });

    it("answers the Test action with a failed result, not a 404, on a dead model", async () => {
      // The settings table renders "Test" on every listed row, dead ones
      // included — a 404 "Model not found" about a row on screen is the wrong
      // answer. Same envelope the client already renders for a failed probe.
      const { model } = await seedDeadPair("Dead test target");

      const res = await app.request(`/api/models/${model.id}/test`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("NEEDS_RECONNECTION");
      expect(body.message).toContain("reconnected");
    });

    it("still 404s the Test action for a model id that does not exist", async () => {
      const res = await app.request(`/api/models/${crypto.randomUUID()}/test`, {
        method: "POST",
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(404);
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
        body: JSON.stringify({ credentialId, model_ids: [TEST_OAUTH_MODEL_ID] }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        created: number;
        ids: string[];
        promoted_default: boolean;
      };
      expect(body.created).toBe(1);
      expect(body.ids).toHaveLength(1);
      expect(body.promoted_default).toBe(true);

      const inserted = await db
        .select()
        .from(orgModels)
        .where(and(eq(orgModels.orgId, ctx.orgId), eq(orgModels.credentialId, credentialId)));
      expect(inserted).toHaveLength(1);
      expect(inserted[0]!.modelId).toBe(TEST_OAUTH_MODEL_ID);
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
        body: JSON.stringify({ credentialId, model_ids: [TEST_OAUTH_MODEL_ID] }),
      });
      expect(first.status).toBe(201);

      const second = await app.request("/api/models/seed", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ credentialId, model_ids: [TEST_OAUTH_MODEL_ID] }),
      });
      expect(second.status).toBe(201);
      const body = (await second.json()) as { created: number; promoted_default: boolean };
      expect(body.created).toBe(0);
      expect(body.promoted_default).toBe(false);
    });

    it("rejects a camelCase `modelIds` and answers in snake_case", async () => {
      const credentialId = await seedTestOAuthCredential();
      const post = (body: unknown) =>
        app.request("/api/models/seed", {
          method: "POST",
          headers: authHeaders(ctx, { "Content-Type": "application/json" }),
          body: JSON.stringify(body),
        });

      expect((await post({ credentialId, modelIds: [TEST_OAUTH_MODEL_ID] })).status).toBe(400);

      const res = await post({ credentialId, model_ids: [TEST_OAUTH_MODEL_ID] });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.promoted_default).toBe(true);
      expect(body).not.toHaveProperty("promotedDefault");
    });

    it("rejects unknown model_ids with 400", async () => {
      const credentialId = await seedTestOAuthCredential();

      const res = await app.request("/api/models/seed", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ credentialId, model_ids: ["does-not-exist"] }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 404 when the credential does not exist", async () => {
      const res = await app.request("/api/models/seed", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          credentialId: "00000000-0000-0000-0000-000000000000",
          model_ids: [TEST_OAUTH_MODEL_ID],
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
        body: JSON.stringify({ credentialId, model_ids: [TEST_OAUTH_MODEL_ID] }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { created: number; promoted_default: boolean };
      expect(body.created).toBe(1);
      expect(body.promoted_default).toBe(false);
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
        "X-Space-Id": ctx.defaultSpaceId,
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
        body: JSON.stringify({ credentialId: key.id, modelId: "gpt-4o", api_key: "sk-test" }),
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

    it("POST /api/models/test → 400 for camelCase key fields", async () => {
      const key = await seedOrgModelProviderKey({
        orgId: ctx.orgId,
        apiShape: "openai",
        baseUrl: "https://api.openai.com",
      });
      for (const camel of [{ apiKey: "sk-test" }]) {
        const res = await app.request("/api/models/test", {
          method: "POST",
          headers: authHeaders(ctx, { "Content-Type": "application/json" }),
          body: JSON.stringify({ credentialId: key.id, modelId: "gpt-4o", ...camel }),
        });
        expect(res.status).toBe(400);
      }
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
        body: JSON.stringify({ credentialId: key.id, modelId: "gpt-4o", api_key: "sk-test" }),
      });
      // The owner passes the permission guard; the body may then succeed or
      // surface a provider error, but it is never an authorization failure.
      expect(res.status).not.toBe(403);
    });
  });

  describe("POST /api/models/:id/test — model alias", () => {
    it("refuses the connection test for an alias (timing + upstream-status oracle)", async () => {
      const credentialId = await createGatewayKey();
      const realModelId = "secret-backing-test-9m2p";

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

      const res = await app.request(`/api/models/${created.id}/test`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      // Refused server-side, BEFORE any upstream fetch: a `{ ok, latency,
      // status }` answer would report the backing's own round-trip time and
      // HTTP status back to the caller, and spend the platform credential
      // doing it.
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).not.toContain(realModelId);
      // The refusal names no backing detail either.
      expect(body).not.toContain("openai");
      expect(body).not.toContain("api.openai.com");
    });

    it("still tests a NON-aliased model (the refusal is alias-scoped)", async () => {
      const key = await seedOrgModelProviderKey({
        orgId: ctx.orgId,
        apiShape: "openai",
        baseUrl: "https://api.openai.com",
      });
      const model = await seedOrgModel({
        orgId: ctx.orgId,
        credentialId: key.id,
        modelId: "gpt-4o",
        label: "Plain model",
      });
      const res = await app.request(`/api/models/${model.id}/test`, {
        method: "POST",
        headers: authHeaders(ctx),
      });
      // The upstream call may succeed or fail on its own merits; what must NOT
      // happen is the alias refusal.
      expect(res.status).not.toBe(400);
    });
  });

  describe("custom (OpenAI-compatible) endpoint — the sequence the SPA emits", () => {
    it("creates the credential then the model, and lists it", async () => {
      const credentialRes = await app.request("/api/model-provider-credentials", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          providerId: "openai-compatible",
          api_key: "sk-test",
          base_url_override: "http://localhost:11434/v1",
        }),
      });
      expect(credentialRes.status).toBe(201);
      const credential = (await credentialRes.json()) as any;

      const createRes = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Local Qwen",
          modelId: "qwen3:8b",
          credentialId: credential.id,
          contextWindow: 32768,
          maxTokens: 8192,
          input: ["text"],
          reasoning: false,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as any;
      // The credential's provider owns both — `org_models` stores neither.
      expect(created.apiShape).toBe("openai-completions");
      expect(created.base_url).toBe("http://localhost:11434/v1");
      expect(created).not.toHaveProperty("baseUrl");
      // No catalog backs this provider, so the typed capabilities are the
      // only source there is and must round-trip verbatim.
      expect(created.contextWindow).toBe(32768);
      expect(created.maxTokens).toBe(8192);
      expect(created.input).toEqual(["text"]);
      expect(created.reasoning).toBe(false);

      const listRes = await app.request("/api/models", { headers: authHeaders(ctx) });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as any;
      expect(list.data.map((m: any) => m.id)).toContain(created.id);
    });

    it("refuses a client-side sentinel as a providerId", async () => {
      // What the model form used to send for a custom endpoint. The registry
      // is the only namespace of provider ids — pinned here so the client can
      // never quietly go back to inventing one.
      const res = await app.request("/api/model-provider-credentials", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          providerId: "__custom__",
          api_key: "sk-test",
          base_url_override: "http://localhost:11434/v1",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.param).toBe("providerId");
    });
  });

  // The probe spends a stored key only on its own credential's base URL.
  describe("POST /api/models/test — stored key stays on its own credential", () => {
    const SYSTEM_MODEL_ID = "sys-model-probe-test";
    const SYSTEM_KEY = "sk-system-probe-secret";
    let seen: string[];

    beforeEach(() => {
      initSystemModelProviderKeys([
        {
          id: "sys-key-probe-test",
          providerId: "openai",
          apiKey: SYSTEM_KEY,
          models: [{ id: SYSTEM_MODEL_ID, modelId: "gpt-4o" }],
        },
      ]);
      seen = [];
      globalThis.fetch = (async (input: string | Request, init?: RequestInit) => {
        const req = new Request(input as string, init);
        seen.push(`${req.url} ${[...req.headers.values()].join(" ")}`);
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;
    });
    afterEach(() => {
      restoreFetch();
      initSystemModelProviderKeys();
    });

    // Public IP literals: the egress guard lets them through without DNS, so a
    // leak would reach the (stubbed) fetch.
    async function callerCredential(): Promise<string> {
      const row = await seedOrgModelProviderKey({
        orgId: ctx.orgId,
        apiShape: "openai-completions",
        baseUrl: "https://9.9.9.9/v1",
        apiKey: "sk-caller",
      });
      return row.id;
    }

    async function probe(body: Record<string, unknown>) {
      return app.request("/api/models/test", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
    }

    it("refuses existing_model_id as an unknown field", async () => {
      const res = await probe({
        credentialId: await callerCredential(),
        modelId: "any-model",
        existing_model_id: SYSTEM_MODEL_ID,
      });
      expect(res.status).toBe(400);
      expect(seen).toEqual([]);
    });

    it("refuses a built-in credential", async () => {
      const res = await probe({ credentialId: "sys-key-probe-test", modelId: "gpt-4o" });
      expect(res.status).toBe(403);
      expect(seen).toEqual([]);
    });

    it("probes with the credential's stored key", async () => {
      const res = await probe({ credentialId: await callerCredential(), modelId: "any-model" });
      expect(res.status).toBe(200);
      expect(
        seen.some((line) => line.startsWith("https://9.9.9.9/") && line.includes("sk-caller")),
      ).toBe(true);
    });
  });
});
