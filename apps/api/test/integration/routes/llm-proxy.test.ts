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
 *      against `org_models` + `org_system_provider_keys`.
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
import { encrypt } from "@appstrate/connect";
import { db } from "@appstrate/db/client";
import { llmUsage } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { seedApiKey, seedOrgProviderKey, seedOrgModel } from "../../helpers/seed.ts";

const app = getTestApp();

interface Harness {
  ctx: TestContext;
  apiKey: string;
  presetId: string;
  providerKeyId: string;
}

async function buildHarness(overrides?: {
  api?: string;
  baseUrl?: string;
  modelId?: string;
  upstreamKey?: string;
  scopes?: string[];
}): Promise<Harness> {
  const ctx = await createTestContext({ orgSlug: "llmproxyorg" });
  const providerKey = await seedOrgProviderKey({
    orgId: ctx.orgId,
    label: "Upstream",
    api: overrides?.api ?? "openai-completions",
    baseUrl: overrides?.baseUrl ?? "https://api.openai.test/v1",
    apiKeyEncrypted: encrypt(overrides?.upstreamKey ?? "sk-upstream-42"),
  });
  const model = await seedOrgModel({
    orgId: ctx.orgId,
    providerKeyId: providerKey.id,
    label: "Preset",
    api: overrides?.api ?? "openai-completions",
    baseUrl: overrides?.baseUrl ?? "https://api.openai.test/v1",
    modelId: overrides?.modelId ?? "gpt-4o-2024-08-06",
    enabled: true,
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
    providerKeyId: providerKey.id,
  };
}

function authHeaders(h: Harness, extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${h.apiKey}`,
    "X-Org-Id": h.ctx.orgId,
    "X-App-Id": h.ctx.defaultAppId,
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
    expect(captured!.url).toBe("https://api.openai.test/v1/chat/completions");
    const forwardedHeaders = new Headers(captured!.init?.headers as Record<string, string>);
    expect(forwardedHeaders.get("authorization")).toBe("Bearer sk-upstream-42");
    const forwardedBody = JSON.parse(new TextDecoder().decode(captured!.init?.body as Uint8Array));
    expect(forwardedBody.model).toBe("gpt-4o-2024-08-06");
    expect(forwardedBody.messages).toEqual([{ role: "user", content: "hi" }]);

    // Metering row — allow the async insert to flush.
    await new Promise((r) => setTimeout(r, 50));
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
    const h = await buildHarness({ api: "anthropic-messages" });
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

    await new Promise((r) => setTimeout(r, 50));
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
        "X-App-Id": h.ctx.defaultAppId,
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
      api: "anthropic-messages",
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

    // SSE tap is async — allow the insert to flush after the stream
    // drains. The promise chain is started at `tee()` time but only
    // resolves once the caller consumed the stream, so we wait a beat.
    await new Promise((r) => setTimeout(r, 100));
    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.orgId, h.ctx.orgId));
    expect(row).toBeDefined();
    expect(row!.inputTokens).toBe(150);
    expect(row!.outputTokens).toBe(77);
    expect(row!.cacheReadTokens).toBe(100);
    expect(row!.cacheWriteTokens).toBe(20);
    expect(row!.api).toBe("anthropic-messages");
  });
});

describe("POST /api/llm-proxy/mistral-conversations/v1/chat/completions", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
  });
  afterEach(() => restoreFetch());

  it("forwards with Authorization: Bearer and substitutes the model id", async () => {
    const h = await buildHarness({
      api: "mistral-conversations",
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
    expect(captured!.url).toBe("https://api.mistral.test/v1/chat/completions");
    expect(captured!.headers.get("Authorization")).toBe("Bearer mistral-upstream-99");
    const forwardedBody = JSON.parse(new TextDecoder().decode(captured!.bodyBytes));
    expect(forwardedBody.model).toBe("mistral-large-latest");
    expect(forwardedBody.temperature).toBe(0.5);

    // The proxy fires `recordUsage` as a void promise after returning the
    // response (see core.ts:154) — same as the OpenAI/Anthropic paths.
    // Give the async insert a tick to land before reading the ledger,
    // otherwise this test races the DB write.
    await new Promise((r) => setTimeout(r, 50));
    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.orgId, h.ctx.orgId));
    expect(row).toBeDefined();
    expect(row!.api).toBe("mistral-conversations");
    expect(row!.inputTokens).toBe(200);
    expect(row!.outputTokens).toBe(80);
  });

  it("returns 400 when the preset uses a different protocol family", async () => {
    const h = await buildHarness({ api: "openai-completions" });
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
