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
import { seedApiKey, seedOrgModelProviderKey, seedOrgModel } from "../../helpers/seed.ts";
import {
  setPortkeyInprocessRouter,
  type PortkeyRouter,
} from "../../../src/services/portkey-router.ts";
import { API_SHAPE_TO_PORTKEY_PROVIDER } from "../../../src/services/pricing-catalog.ts";

/**
 * Restore the preload-baseline router (passthrough mock pointing at
 * `127.0.0.1:8787`). Tests that need a different router install their
 * own, then call this in `afterEach` so the next test starts from a
 * clean known state — never `() => null`, which would crash subsequent
 * tests now that Portkey routing is mandatory.
 */
function installBaselineInprocessRouter(): void {
  setPortkeyInprocessRouter((model) => {
    const provider = API_SHAPE_TO_PORTKEY_PROVIDER[model.apiShape];
    if (!provider) return null;
    // Mirror production: OpenAI/Mistral SDKs append `/chat/completions`
    // to a `/v1`-baked baseUrl; Anthropic SDK already includes `/v1`
    // in the request path, so the gateway baseUrl stays bare.
    const prefix = model.apiShape === "anthropic-messages" ? "" : "/v1";
    return {
      baseUrl: `http://127.0.0.1:8787${prefix}`,
      portkeyConfig: JSON.stringify({ provider, api_key: model.apiKey }),
    };
  });
}
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
    apiShape: overrides?.apiShape ?? "openai-completions",
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
    // Portkey is mandatory — every api_key call is routed through the
    // local gateway; the preload installs a passthrough router pointing
    // at `127.0.0.1:8787`.
    expect(captured!.url).toBe("http://127.0.0.1:8787/v1/chat/completions");
    const forwardedHeaders = new Headers(captured!.init?.headers as Record<string, string>);
    expect(forwardedHeaders.get("authorization")).toBe("Bearer sk-upstream-42");
    expect(forwardedHeaders.get("x-portkey-config")).not.toBeNull();
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
      baseUrl: "https://api.mistral.test/v1",
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
    // Portkey-mandatory: URL is the gateway, Portkey routes upstream.
    expect(captured!.url).toBe("http://127.0.0.1:8787/v1/chat/completions");
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
 * Portkey in-process routing — covers phase 1.5 (#437) wiring of
 * `services/llm-proxy/*` through the optional Portkey gateway.
 *
 * The legacy direct-upstream path is already covered by every test
 * above (no router installed). These tests exercise the router-installed
 * path: upstream URL is swapped to the gateway, `x-portkey-config` is
 * injected on the upstream call, and cost tracking still happens
 * (Portkey is transparent — adapter parses the same response shape).
 */
describe("POST /api/llm-proxy/* — Portkey in-process routing (#437)", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
  });

  afterEach(() => {
    restoreFetch();
    installBaselineInprocessRouter();
  });

  it("swaps upstream to Portkey and injects x-portkey-config when the router is installed", async () => {
    const h = await buildHarness();

    // Mirrors the production routing emitted by
    // `apps/api/src/modules/portkey/config.ts`: OpenAI-family shapes get
    // `/v1` baked into the routing baseUrl so the proxy's appended
    // `/chat/completions` lands on Portkey's `/v1/chat/completions`.
    const router: PortkeyRouter = (model) => ({
      baseUrl: "http://127.0.0.1:8787/v1",
      portkeyConfig: JSON.stringify({
        provider: "openai",
        api_key: model.apiKey,
        retry: { attempts: 3, on_status_codes: [429, 500, 502, 503, 504] },
      }),
    });
    setPortkeyInprocessRouter(router);

    let captured: {
      url: string;
      headers: Headers;
      bodyBytes: Uint8Array;
      init: RequestInit & { decompress?: boolean };
    } | null = null;
    mockUpstream(async (input, init) => {
      captured = {
        url: typeof input === "string" ? input : (input as URL).toString(),
        headers: new Headers(init?.headers as Record<string, string>),
        bodyBytes: init?.body as Uint8Array,
        init: (init ?? {}) as RequestInit & { decompress?: boolean },
      };
      return new Response(
        JSON.stringify({
          id: "chatcmpl_pk",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
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
    expect(captured).not.toBeNull();
    // URL re-pointed at the local Portkey gateway, path preserved verbatim.
    expect(captured!.url).toBe("http://127.0.0.1:8787/v1/chat/completions");
    // The inline `x-portkey-config` carries the routing + credential.
    const cfg = captured!.headers.get("x-portkey-config");
    expect(cfg).not.toBeNull();
    const parsed = JSON.parse(cfg!) as { provider: string; api_key: string };
    expect(parsed.provider).toBe("openai");
    expect(parsed.api_key).toBe("sk-upstream-42");
    // `accept-encoding: identity` is force-injected when Portkey is in
    // the path — works around Bun fetch ZlibError on Anthropic SSE
    // through the gateway (discovered in #437 real-key smoke).
    expect(captured!.headers.get("accept-encoding")).toBe("identity");
    // `decompress: false` on the Bun fetch — Portkey 1.15.2 OSS lies
    // about Content-Encoding (says "br"/"gzip" while the bytes are
    // already identity because Portkey internally decoded upstream).
    // Letting Bun auto-decompress trips `BrotliDecompressionError` /
    // `ZlibError` on every response. The flag keeps the bytes raw, and
    // `cloneResponseHeaders` strips the bogus encoding before forwarding.
    expect(captured!.init.decompress).toBe(false);
    // Body still has the substituted real-model id (adapter ran).
    const body = JSON.parse(new TextDecoder().decode(captured!.bodyBytes));
    expect(body.model).toBe("gpt-4o-2024-08-06");
    // Cost is still recorded — Portkey is transparent for usage parsing.
    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.orgId, h.ctx.orgId));
    expect(row).toBeDefined();
    expect(row!.inputTokens).toBe(12);
    expect(row!.outputTokens).toBe(8);
  });

  it("fails fast when the router cannot route the apiShape (unmapped)", async () => {
    const h = await buildHarness();
    // Router installed but rejects this model — Portkey is mandatory,
    // so unroutable shapes are a config bug and must surface a clear
    // 5xx rather than silently bypassing the gateway.
    setPortkeyInprocessRouter(() => null);

    let upstreamHit = false;
    mockUpstream(async () => {
      upstreamHit = true;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body: JSON.stringify({
        model: h.presetId,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { detail?: string; title?: string };
    expect(body.detail ?? body.title ?? "").toMatch(/Portkey provider mapping/i);
    // Crucially: no upstream call was made — the proxy fails before fetch.
    expect(upstreamHit).toBe(false);
  });

  it("forwards the body unmodified when Portkey lies about Content-Encoding (#437 follow-up)", async () => {
    // Regression for the brotli/gzip decompression crash discovered
    // post-merge. Portkey 1.15.2 OSS sets `Content-Encoding: br` on
    // responses whose body is already identity (Portkey internally
    // decoded upstream's brotli for metrics but kept the original header).
    // With Bun's auto-decompression we crashed every call; with
    // `decompress: false` the bytes pass through and `cloneResponseHeaders`
    // drops the bogus encoding so the consumer sees a clean payload.
    const h = await buildHarness();
    setPortkeyInprocessRouter((model) => ({
      baseUrl: "http://127.0.0.1:8787/v1",
      portkeyConfig: JSON.stringify({ provider: "openai", api_key: model.apiKey }),
    }));

    // Plain identity JSON — but advertised as brotli (Portkey's lie).
    const upstreamBody = JSON.stringify({
      id: "chatcmpl_liar",
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });

    mockUpstream(async () => {
      return new Response(upstreamBody, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-encoding": "br", // ← the lie
        },
      });
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
    // Bogus encoding header MUST be stripped.
    expect(res.headers.get("content-encoding")).toBeNull();
    // Body passes through verbatim — no double-decoding, no truncation.
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("chatcmpl_liar");
    // Usage row still recorded — cost metering is decoupled from
    // transport quirks.
    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.orgId, h.ctx.orgId));
    expect(row).toBeDefined();
    expect(row!.inputTokens).toBe(3);
    expect(row!.outputTokens).toBe(2);
  });
});

/**
 * Response-level cache (#437 Phase 4a) — `services/llm-proxy/response-cache.ts`.
 *
 * Portkey 1.15.2 OSS exposes a `cache: { mode }` contract in inline
 * config but its standalone `start-server.js` never installs the
 * `getFromCache` middleware, so every response comes back
 * `cacheStatus: DISABLED` regardless of mode. Appstrate owns the cache
 * layer instead and emits a Portkey-compatible `x-portkey-cache-status`
 * header so consumers (and observability) treat HIT/MISS uniformly.
 *
 * These tests assert the cache contract independent of the upstream
 * transport: identical (orgId, presetId, apiShape, model, body) → HIT
 * on the second call; differences anywhere in the key → MISS.
 */
describe("POST /api/llm-proxy/* — response cache (#437 Phase 4a)", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    setResponseCacheConfig({ enabled: true, ttlSeconds: 120 });
  });

  afterEach(() => {
    restoreFetch();
    resetResponseCacheConfigForTesting();
  });

  it("returns x-portkey-cache-status: MISS on first call and HIT on identical second call", async () => {
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
    expect(first.headers.get("x-portkey-cache-status")).toBe("MISS");
    const firstJson = (await first.json()) as { id: string };
    expect(firstJson.id).toBe("chatcmpl_1");

    const second = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body,
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("x-portkey-cache-status")).toBe("HIT");
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
    expect(a.headers.get("x-portkey-cache-status")).toBe("MISS");
    const b = await callWith("second prompt");
    expect(b.headers.get("x-portkey-cache-status")).toBe("MISS");
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
    expect(first.headers.get("x-portkey-cache-status")).toBeNull();
    await first.text(); // drain

    const second = await app.request("/api/llm-proxy/anthropic-messages/v1/messages", {
      method: "POST",
      headers: authHeaders(h, { "anthropic-version": "2024-10-01" }),
      body,
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("x-portkey-cache-status")).toBeNull();
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
    expect(first.headers.get("x-portkey-cache-status")).toBeNull();

    const second = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: authHeaders(h),
      body,
    });
    expect(second.headers.get("x-portkey-cache-status")).toBeNull();
    expect(upstreamCalls).toBe(2);
  });
});
