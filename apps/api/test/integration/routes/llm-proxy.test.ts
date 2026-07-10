// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `/api/llm-proxy/*` — server-side model injection
 * for remote-backed AFPS runs.
 *
 * Pinned contract:
 *
 *   1. Bearer auth only. API keys with `llm-proxy:call` pass. Cookie
 *      sessions refused with 403. Missing scope refused with 403.
 *
 *   2. Request body.model is a preset id — the platform substitutes the
 *      real upstream model id before forwarding. `loadModel()` resolves
 *      against `org_models` + `model_provider_credentials`.
 *
 *   3. Protocol mismatch (preset.api != route.api) → 400.
 *
 *   4. Non-streaming JSON: usage is parsed server-side and persisted into
 *      `llm_usage` (source='proxy') with cost_usd derived from the preset's cost.
 *      Failures in the upstream bubble as-is; no usage row is minted.
 *
 *   5. Streaming SSE: the response passes through verbatim to the caller,
 *      while a tapped copy accumulates usage asynchronously.
 *
 *   6. `X-Run-Id` header is persisted on the usage row for per-run rollup.
 *
 * We stub `globalThis.fetch` to intercept the upstream call — no real
 * network traffic leaves the test harness.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { llmUsage } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { flushRedis } from "../../helpers/redis.ts";
import {
  seedApiKey,
  seedOrgModelProviderKey,
  seedOrgModel,
  seedPackage,
  seedRun,
  seedApplication,
} from "../../helpers/seed.ts";
import {
  resetResponseCacheConfigForTesting,
  setResponseCacheConfig,
} from "../../../src/lib/llm-proxy-cache-config.ts";

const app = getTestApp();

interface Harness {
  ctx: TestContext;
  apiKey: string;
  presetId: string;
  credentialId: string;
}

async function buildHarness(overrides?: {
  apiShape?: string;
  baseUrl?: string;
  modelId?: string;
  upstreamKey?: string;
  scopes?: string[];
  aliased?: boolean;
}): Promise<Harness> {
  const ctx = await createTestContext({ orgSlug: "llmproxyorg" });
  const providerKey = await seedOrgModelProviderKey({
    orgId: ctx.orgId,
    label: "Upstream",
    apiShape: overrides?.apiShape ?? "openai-completions",
    baseUrl: overrides?.baseUrl ?? "https://api.openai.test/v1",
    apiKey: overrides?.upstreamKey ?? "sk-upstream-42",
  });
  const model = await seedOrgModel({
    orgId: ctx.orgId,
    credentialId: providerKey.id,
    label: "Preset",
    modelId: overrides?.modelId ?? "gpt-4o-2024-08-06",
    enabled: true,
    aliased: overrides?.aliased ?? false,
    cost: { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 },
  });
  const key = await seedApiKey({
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    createdBy: ctx.user.id,
    scopes: overrides?.scopes ?? ["llm-proxy:call"],
  });
  return {
    ctx,
    apiKey: key.rawKey,
    presetId: model.id,
    credentialId: providerKey.id,
  };
}

function authHeaders(h: Harness, extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${h.apiKey}`,
    "X-Org-Id": h.ctx.orgId,
    "X-Application-Id": h.ctx.defaultAppId,
    "Content-Type": "application/json",
    ...extra,
  };
}

// Swap globalThis.fetch per-test so the proxy's upstream call can be
// controlled without touching the network. The signature is intentionally
// narrow — Bun's `typeof fetch` carries a `preconnect` member we don't
// need to implement for the proxy's one-shot call, so we cast at the
// assignment boundary.
type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let originalFetch: typeof fetch;
function mockUpstream(impl: FetchImpl): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
}
function restoreFetch(): void {
  if (originalFetch) globalThis.fetch = originalFetch;
}

describe("POST /api/llm-proxy/openai-completions/v1/chat/completions", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
  });
  afterEach(() => restoreFetch());

  it("forwards the request with the substituted model and records usage", async () => {
    const h = await buildHarness();
    let captured: { url: string; init?: RequestInit } | null = null;

    mockUpstream(async (input, init) => {
      captured = {
        url: typeof input === "string" ? input : (input as URL).toString(),
        init,
      };
      return new Response(
        JSON.stringify({
          id: "chatcmpl_x",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 42,
            prompt_tokens_details: { cached_tokens: 30 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body: JSON.stringify({
        model: h.presetId,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { usage?: { prompt_tokens: number } };
    expect(json.usage?.prompt_tokens).toBe(100);

    expect(captured).not.toBeNull();
    // The proxy forwards directly to the preset's upstream baseUrl —
    // `joinUpstreamUrl(resolved.baseUrl, upstreamPath)`.
    expect(captured!.url).toBe("https://api.openai.test/v1/chat/completions");
    const forwardedHeaders = new Headers(captured!.init?.headers as Record<string, string>);
    expect(forwardedHeaders.get("authorization")).toBe("Bearer sk-upstream-42");
    const forwardedBody = JSON.parse(new TextDecoder().decode(captured!.init?.body as Uint8Array));
    expect(forwardedBody.model).toBe("gpt-4o-2024-08-06");
    expect(forwardedBody.messages).toEqual([{ role: "user", content: "hi" }]);

    // Metering row — `recordUsage` is awaited on the non-streaming path,
    // so the row is committed before the response returns. No sleep needed.
    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.orgId, h.ctx.orgId));
    expect(row).toBeDefined();
    expect(row!.model).toBe(h.presetId);
    expect(row!.realModel).toBe("gpt-4o-2024-08-06");
    expect(row!.inputTokens).toBe(100);
    expect(row!.outputTokens).toBe(42);
    expect(row!.cacheReadTokens).toBe(30);
    expect(row!.apiKeyId).toBeDefined();
    expect(row!.userId).toBeNull();
    expect(row!.runId).toBeNull();
    // cost = 100*5/1M + 42*15/1M = 0.0005 + 0.00063 = 0.00113
    expect(row!.costUsd).toBeCloseTo(0.00113, 6);
  });

  it("returns 403 when the API key is missing llm-proxy:call scope", async () => {
    const h = await buildHarness({ scopes: ["runs:read"] });
    mockUpstream(async () => new Response("should not be called", { status: 599 }));

    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body: JSON.stringify({
        model: h.presetId,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 when the preset does not exist for the org", async () => {
    const h = await buildHarness();
    mockUpstream(async () => new Response("should not be called", { status: 599 }));
    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body: JSON.stringify({
        model: "m_nonexistent",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when the preset uses a different protocol family", async () => {
    const h = await buildHarness({ apiShape: "anthropic-messages" });
    mockUpstream(async () => new Response("should not be called", { status: 599 }));
    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body: JSON.stringify({
        model: h.presetId,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(400);
    // Non-aliased presets keep the actionable detail — the message names the
    // preset's actual protocol family so the caller can pick the right route.
    expect(await res.text()).toContain("anthropic-messages");
  });

  it("masks the backing protocol family on an apiShape mismatch for an aliased preset", async () => {
    // For an alias the public DTO nulls apiShape (`projectAliasedModel`), so
    // the mismatch message must not name the backing family either.
    const h = await buildHarness({ apiShape: "anthropic-messages", aliased: true });
    mockUpstream(async () => new Response("should not be called", { status: 599 }));
    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body: JSON.stringify({
        model: h.presetId,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("anthropic");
    expect(text).toContain("is not served by this endpoint");
  });

  it("forwards upstream errors verbatim without recording usage", async () => {
    const h = await buildHarness();
    mockUpstream(
      async () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    );

    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body: JSON.stringify({
        model: h.presetId,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(429);

    // Upstream-error path never reaches `recordUsage` (see core.ts:114),
    // so there's no async write to wait for — assert directly.
    const rows = await db.select().from(llmUsage).where(eq(llmUsage.orgId, h.ctx.orgId));
    expect(rows).toHaveLength(0);
  });

  it("rejects cookie sessions with 403 (bearer-only)", async () => {
    const h = await buildHarness();
    mockUpstream(async () => new Response("should not be called", { status: 599 }));

    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: {
        Cookie: h.ctx.cookie,
        "X-Org-Id": h.ctx.orgId,
        "X-Application-Id": h.ctx.defaultAppId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: h.presetId,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail ?? "").toMatch(/auth method/i);
  });

  it("rejects a malformed body with 400 (no upstream call)", async () => {
    const h = await buildHarness();
    let upstreamHit = false;
    mockUpstream(async () => {
      upstreamHit = true;
      return new Response("x", { status: 200 });
    });
    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body: "not-json",
    });
    expect(res.status).toBe(400);
    expect(upstreamHit).toBe(false);
  });
});

describe("POST /api/llm-proxy/anthropic-messages/v1/messages", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
  });
  afterEach(() => restoreFetch());

  it("forwards with x-api-key and merges SSE usage frames", async () => {
    const h = await buildHarness({
      apiShape: "anthropic-messages",
      baseUrl: "https://api.anthropic.test",
      modelId: "claude-sonnet-4-5-20250929",
      upstreamKey: "sk-ant-42",
    });

    let captured: { headers: Headers; bodyBytes: Uint8Array } | null = null;

    const sseBody =
      `event: message_start\n` +
      `data: {"type":"message_start","message":{"usage":{"input_tokens":150,"cache_read_input_tokens":100,"cache_creation_input_tokens":20,"output_tokens":1}}}\n\n` +
      `event: content_block_delta\n` +
      `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n` +
      `event: message_delta\n` +
      `data: {"type":"message_delta","usage":{"output_tokens":77}}\n\n` +
      `event: message_stop\n` +
      `data: {"type":"message_stop"}\n\n`;

    mockUpstream(async (_input, init) => {
      captured = {
        headers: new Headers(init?.headers as Record<string, string>),
        bodyBytes: init?.body as Uint8Array,
      };
      return new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const res = await app.request("/api/llm-proxy/anthropic-messages/v1/messages", {
      method: "POST",
      headers: authHeaders(h, { "anthropic-version": "2024-10-01" }),
      body: JSON.stringify({
        model: h.presetId,
        max_tokens: 512,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const echoedBody = await res.text();
    expect(echoedBody).toBe(sseBody);

    expect(captured).not.toBeNull();
    expect(captured!.headers.get("x-api-key")).toBe("sk-ant-42");
    expect(captured!.headers.get("anthropic-version")).toBe("2024-10-01");
    const forwardedBody = JSON.parse(new TextDecoder().decode(captured!.bodyBytes));
    expect(forwardedBody.model).toBe("claude-sonnet-4-5-20250929");

    // SSE tap is genuinely async: the response stream is tee'd, and the
    // metering insert only runs once the tap copy has been fully drained
    // and parsed. There's no observable signal we can synchronously
    // await from the test (the route discards the metering promise on
    // purpose so a slow DB doesn't block the response). Poll until the
    // row materialises instead of guessing a sleep length.
    const row = await waitForRow(() =>
      db.select().from(llmUsage).where(eq(llmUsage.orgId, h.ctx.orgId)).limit(1),
    );
    expect(row.inputTokens).toBe(150);
    expect(row.outputTokens).toBe(77);
    expect(row.cacheReadTokens).toBe(100);
    expect(row.cacheWriteTokens).toBe(20);
    expect(row.api).toBe("anthropic-messages");
  });
});

/**
 * Poll a query until it returns a row, or the deadline elapses. Used
 * exclusively by the SSE-streaming metering test where the insert is
 * tee'd off the response stream and cannot be awaited synchronously.
 *
 * Polling beats a fixed `setTimeout`: the test passes as soon as the
 * insert lands (no padding), and stops cleanly with a clear error if
 * the contract regresses (no quiet timeout, no "tests pass on fast
 * machines / fail on CI" flakes).
 */
async function waitForRow<T>(
  query: () => Promise<T[]>,
  { timeoutMs = 1000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await query();
    if (rows.length > 0) return rows[0]!;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitForRow: row never materialised within ${timeoutMs}ms`);
}

describe("POST /api/llm-proxy/mistral-conversations/v1/chat/completions", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
  });
  afterEach(() => restoreFetch());

  it("forwards with Authorization: Bearer and substitutes the model id", async () => {
    const h = await buildHarness({
      apiShape: "mistral-conversations",
      baseUrl: "https://api.mistral.test",
      modelId: "mistral-large-latest",
      upstreamKey: "mistral-upstream-99",
    });

    let captured: { url: string; headers: Headers; bodyBytes: Uint8Array } | null = null;

    mockUpstream(async (input, init) => {
      captured = {
        url: typeof input === "string" ? input : (input as URL).toString(),
        headers: new Headers(init?.headers as Record<string, string>),
        bodyBytes: init?.body as Uint8Array,
      };
      return new Response(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const res = await app.request("/api/llm-proxy/mistral-conversations/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body: JSON.stringify({
        model: h.presetId,
        messages: [{ role: "user", content: "salut" }],
        temperature: 0.5,
      }),
    });

    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    // Direct upstream — the Mistral SDK convention appends
    // `/v1/chat/completions` to its serverURL, mirrored by the proxy's
    // `upstreamPath` ("/v1/chat/completions"). Preset `baseUrl` is bare.
    expect(captured!.url).toBe("https://api.mistral.test/v1/chat/completions");
    expect(captured!.headers.get("Authorization")).toBe("Bearer mistral-upstream-99");
    const forwardedBody = JSON.parse(new TextDecoder().decode(captured!.bodyBytes));
    expect(forwardedBody.model).toBe("mistral-large-latest");
    expect(forwardedBody.temperature).toBe(0.5);

    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.orgId, h.ctx.orgId));
    expect(row).toBeDefined();
    expect(row!.api).toBe("mistral-conversations");
    expect(row!.inputTokens).toBe(200);
    expect(row!.outputTokens).toBe(80);
  });

  it("returns 400 when the preset uses a different protocol family", async () => {
    const h = await buildHarness({ apiShape: "openai-completions" });
    const res = await app.request("/api/llm-proxy/mistral-conversations/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body: JSON.stringify({
        model: h.presetId,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(400);
  });
});

/**
 * Response-level cache — `services/llm-proxy/response-cache.ts`. Opt-in
 * via `LLM_PROXY_CACHE_MODE`. Tests assert the cache contract
 * independent of the upstream transport: identical (orgId, presetId,
 * apiShape, model, body) → HIT on the second call; differences anywhere
 * in the key → MISS.
 */
describe("POST /api/llm-proxy/* — response cache", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    setResponseCacheConfig({ enabled: true, ttlSeconds: 120 });
  });

  afterEach(() => {
    restoreFetch();
    resetResponseCacheConfigForTesting();
  });

  it("returns x-llm-proxy-cache-status: MISS on first call and HIT on identical second call", async () => {
    const h = await buildHarness();
    let upstreamCalls = 0;

    mockUpstream(async () => {
      upstreamCalls += 1;
      return new Response(
        JSON.stringify({
          id: `chatcmpl_${upstreamCalls}`,
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const body = JSON.stringify({
      model: h.presetId,
      messages: [{ role: "user", content: "cache me" }],
    });

    const first = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body,
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("x-llm-proxy-cache-status")).toBe("MISS");
    const firstJson = (await first.json()) as { id: string };
    expect(firstJson.id).toBe("chatcmpl_1");

    const second = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body,
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("x-llm-proxy-cache-status")).toBe("HIT");
    const secondJson = (await second.json()) as { id: string };
    // Replayed verbatim — same id as the first call, no upstream re-hit.
    expect(secondJson.id).toBe("chatcmpl_1");
    expect(upstreamCalls).toBe(1);
  });

  it("misses when the request body changes (key includes request payload)", async () => {
    const h = await buildHarness();
    let upstreamCalls = 0;

    mockUpstream(async () => {
      upstreamCalls += 1;
      return new Response(
        JSON.stringify({
          id: `chatcmpl_${upstreamCalls}`,
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const callWith = (prompt: string) =>
      app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
        method: "POST",
        headers: authHeaders(h),
        body: JSON.stringify({
          model: h.presetId,
          messages: [{ role: "user", content: prompt }],
        }),
      });

    const a = await callWith("first prompt");
    expect(a.headers.get("x-llm-proxy-cache-status")).toBe("MISS");
    const b = await callWith("second prompt");
    expect(b.headers.get("x-llm-proxy-cache-status")).toBe("MISS");
    expect(upstreamCalls).toBe(2);
  });

  it("skips the cache entirely for streaming requests", async () => {
    const h = await buildHarness({
      apiShape: "anthropic-messages",
      baseUrl: "https://api.anthropic.test",
      modelId: "claude-sonnet-4-5-20250929",
      upstreamKey: "sk-ant-42",
    });

    const sseBody =
      `event: message_start\n` +
      `data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n` +
      `event: message_delta\n` +
      `data: {"type":"message_delta","usage":{"output_tokens":3}}\n\n` +
      `event: message_stop\n` +
      `data: {"type":"message_stop"}\n\n`;

    let upstreamCalls = 0;
    mockUpstream(async () => {
      upstreamCalls += 1;
      return new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const body = JSON.stringify({
      model: h.presetId,
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });

    const first = await app.request("/api/llm-proxy/anthropic-messages/v1/messages", {
      method: "POST",
      headers: authHeaders(h, { "anthropic-version": "2024-10-01" }),
      body,
    });
    expect(first.status).toBe(200);
    // Streaming responses are not tagged with cache status — they bypass
    // the cache layer entirely.
    expect(first.headers.get("x-llm-proxy-cache-status")).toBeNull();
    await first.text(); // drain

    const second = await app.request("/api/llm-proxy/anthropic-messages/v1/messages", {
      method: "POST",
      headers: authHeaders(h, { "anthropic-version": "2024-10-01" }),
      body,
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("x-llm-proxy-cache-status")).toBeNull();
    await second.text();
    expect(upstreamCalls).toBe(2);
  });

  it("does not cache upstream error responses (4xx/5xx)", async () => {
    const h = await buildHarness();
    let upstreamCalls = 0;

    mockUpstream(async () => {
      upstreamCalls += 1;
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    });

    const body = JSON.stringify({
      model: h.presetId,
      messages: [{ role: "user", content: "hi" }],
    });

    const first = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body,
    });
    expect(first.status).toBe(429);
    const second = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body,
    });
    expect(second.status).toBe(429);
    // Both requests hit upstream — 4xx bodies must never be cached.
    expect(upstreamCalls).toBe(2);
  });

  it("is fully disabled when setResponseCacheConfig({ enabled: false }) — no header, no replay", async () => {
    setResponseCacheConfig({ enabled: false, ttlSeconds: 0 });
    const h = await buildHarness();
    let upstreamCalls = 0;

    mockUpstream(async () => {
      upstreamCalls += 1;
      return new Response(
        JSON.stringify({
          id: `chatcmpl_${upstreamCalls}`,
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const body = JSON.stringify({
      model: h.presetId,
      messages: [{ role: "user", content: "hi" }],
    });

    const first = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body,
    });
    expect(first.headers.get("x-llm-proxy-cache-status")).toBeNull();

    const second = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body,
    });
    expect(second.headers.get("x-llm-proxy-cache-status")).toBeNull();
    expect(upstreamCalls).toBe(2);
  });
});

// CRIT-07 — `X-Run-Id` is caller-supplied and feeds `llm_usage.run_id` →
// `computeRunCost` → `runs.cost`. Pre-fix the header was persisted verbatim,
// so any principal holding `llm-proxy:call` could inflate the cost of ANY run
// whose id it knew — including another tenant's. The fix validates the run
// against the principal's org + application BEFORE the upstream call.
describe("POST /api/llm-proxy/* — X-Run-Id run-attribution guard (CRIT-07)", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
  });
  afterEach(() => restoreFetch());

  /** Seed an agent package + run inside the given (org, application). */
  async function seedRunIn(orgId: string, applicationId: string): Promise<string> {
    const pkg = await seedPackage({ orgId });
    const run = await seedRun({ packageId: pkg.id, orgId, applicationId });
    return run.id;
  }

  function callWithRunId(h: Harness, runId: string): Promise<Response> {
    return app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h, { "X-Run-Id": runId }),
      body: JSON.stringify({
        model: h.presetId,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
  }

  it("404s an X-Run-Id of another tenant's run — same status/shape as a nonexistent id, no upstream call, no usage row", async () => {
    const h = await buildHarness();
    // Victim tenant with a real run the attacker knows the id of.
    const victim = await createTestContext({ orgSlug: "crit07-victim" });
    const victimRunId = await seedRunIn(victim.orgId, victim.defaultAppId);

    let upstreamHit = false;
    mockUpstream(async () => {
      upstreamHit = true;
      return new Response("must not be reached", { status: 599 });
    });

    const crossTenant = await callWithRunId(h, victimRunId);
    expect(crossTenant.status).toBe(404);

    // No existence oracle: a run id that exists in another org and a run id
    // that exists nowhere must be indistinguishable to the caller.
    const nonexistent = await callWithRunId(h, "run_00000000000000ff");
    expect(nonexistent.status).toBe(404);
    const crossBody = (await crossTenant.json()) as Record<string, unknown>;
    const missingBody = (await nonexistent.json()) as Record<string, unknown>;
    expect(crossBody.status).toBe(missingBody.status);
    expect(crossBody.title).toBe(missingBody.title);
    expect(Object.keys(crossBody).sort()).toEqual(Object.keys(missingBody).sort());

    // Rejected before the upstream call — no forwarding, no metering.
    expect(upstreamHit).toBe(false);
    const usageRows = await db.select().from(llmUsage);
    expect(usageRows).toHaveLength(0);
  });

  it("404s an X-Run-Id of a run in ANOTHER application of the key's own org, and mints no usage row", async () => {
    const h = await buildHarness();
    // Same org, different application — API keys are app-bound, so the
    // application boundary must hold even inside the key's own tenant.
    const otherApp = await seedApplication({ orgId: h.ctx.orgId, name: "CRIT07 Other App" });
    const foreignAppRunId = await seedRunIn(h.ctx.orgId, otherApp.id);

    let upstreamHit = false;
    mockUpstream(async () => {
      upstreamHit = true;
      return new Response("must not be reached", { status: 599 });
    });

    const res = await callWithRunId(h, foreignAppRunId);
    expect(res.status).toBe(404);
    expect(upstreamHit).toBe(false);
    const usageRows = await db.select().from(llmUsage);
    expect(usageRows).toHaveLength(0);
  });

  it("accepts an X-Run-Id of a run in the key's own application and pins the usage row to it", async () => {
    const h = await buildHarness();
    const ownRunId = await seedRunIn(h.ctx.orgId, h.ctx.defaultAppId);

    mockUpstream(
      async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl_run",
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 11, completion_tokens: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const res = await callWithRunId(h, ownRunId);
    expect(res.status).toBe(200);

    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.runId, ownRunId));
    expect(row).toBeDefined();
    expect(row!.orgId).toBe(h.ctx.orgId);
    expect(row!.inputTokens).toBe(11);
  });
});

// Model aliases (issue #727, Threat A): the gateway is a user-reachable
// inference path. When the preset is an alias, the upstream echoes the REAL id
// in its response `model` field (and may name it in error prose) — the gateway
// must rewrite it back to the alias before the body (and the cache) leave the
// server, so a caller never learns the backing.
describe("POST /api/llm-proxy/* — model-alias swap", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
  });
  afterEach(() => restoreFetch());

  it("rewrites the echoed real id back to the alias in a non-stream JSON response", async () => {
    const h = await buildHarness({ aliased: true, modelId: "deepseek-chat-SECRET" });
    let forwardedModel = "";

    mockUpstream(async (_input, init) => {
      forwardedModel = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)).model;
      // Upstream echoes the real id back, both as the field and in content.
      return new Response(
        JSON.stringify({
          id: "chatcmpl_x",
          model: "deepseek-chat-SECRET",
          choices: [{ message: { role: "assistant", content: "I am deepseek-chat-SECRET" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body: JSON.stringify({ model: h.presetId, messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    // The request was forwarded with the REAL id; the response carries the ALIAS.
    expect(forwardedModel).toBe("deepseek-chat-SECRET");
    const json = JSON.parse(text);
    expect(json.model).toBe(h.presetId);
    // Field swapped; content mention left intact (exact-value match, not blind replace).
    expect(json.choices[0].message.content).toBe("I am deepseek-chat-SECRET");

    // The ledger keeps the real backing privately (admin/cloud only).
    const row = await waitForRow(() =>
      db.select().from(llmUsage).where(eq(llmUsage.orgId, h.ctx.orgId)).limit(1),
    );
    expect(row.model).toBe(h.presetId);
    expect(row.realModel).toBe("deepseek-chat-SECRET");
  });

  it("rewrites the echoed real id back to the alias in every SSE frame", async () => {
    const h = await buildHarness({
      apiShape: "anthropic-messages",
      baseUrl: "https://api.anthropic.test",
      modelId: "deepseek-chat-SECRET",
      upstreamKey: "sk-ant-42",
      aliased: true,
    });
    const sseBody =
      `event: message_start\n` +
      `data: {"type":"message_start","message":{"id":"m","model":"deepseek-chat-SECRET","usage":{"input_tokens":10,"output_tokens":1}}}\n\n` +
      `event: message_delta\n` +
      `data: {"type":"message_delta","usage":{"output_tokens":5}}\n\n` +
      `event: message_stop\n` +
      `data: {"type":"message_stop"}\n\n`;
    mockUpstream(
      async () =>
        new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    const res = await app.request("/api/llm-proxy/anthropic-messages/v1/messages", {
      method: "POST",
      headers: authHeaders(h, { "anthropic-version": "2024-10-01" }),
      body: JSON.stringify({
        model: h.presetId,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const echoed = await res.text();
    expect(echoed).not.toContain("deepseek-chat-SECRET");
    expect(echoed).toContain(`"model":"${h.presetId}"`);
  });

  it("replaces an upstream error body with the synthetic envelope (never forwarded)", async () => {
    // Error bodies are free-form prose that can name the backing anywhere, so
    // for an alias they are synthesized (whitelist by construction), never
    // forwarded-and-scrubbed: nothing of the upstream prose may survive.
    const h = await buildHarness({ aliased: true, modelId: "deepseek-chat-SECRET" });
    mockUpstream(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "The model `deepseek-chat-SECRET` is overloaded" } }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
    );

    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body: JSON.stringify({ model: h.presetId, messages: [{ role: "user", content: "hi" }] }),
    });

    // Status preserved for caller retry/backoff; body is the neutral envelope.
    expect(res.status).toBe(429);
    const text = await res.text();
    expect(text).toContain(h.presetId);
    expect(text).toContain("Upstream model error");
    expect(text).not.toContain("deepseek-chat-SECRET");
    expect(text).not.toContain("overloaded");
  });
});
