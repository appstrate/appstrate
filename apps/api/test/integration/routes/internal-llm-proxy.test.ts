// SPDX-License-Identifier: Apache-2.0

/**
 * `/internal/llm-proxy/*` — the run's own inference entry. A platform run on an
 * API-key model — platform-provided or the org's own — reaches the metered
 * llm-proxy through its sidecar, authenticated by the run token, so the vendor
 * key never leaves the API.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { llmUsage } from "@appstrate/db/schema";
import type { AppstrateModule, BeforeUsageParams, ModuleInitContext } from "@appstrate/core/module";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedOrgModel, seedOrgModelProviderKey, seedPackage, seedRun } from "../../helpers/seed.ts";
import { signRunToken } from "../../../src/lib/run-token.ts";
import { getLlmProxyLimits } from "../../../src/services/proxy-limits.ts";
import { initSystemModelProviderKeys } from "../../../src/services/model-registry.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { loadModulesFromInstances, resetModules } from "../../../src/lib/modules/module-loader.ts";
import { restoreDiscoveredModules } from "../../helpers/test-modules.ts";

const app = getTestApp();
const SYSTEM_PRESET = "system-run-preset";
const OTHER_PRESET = "system-other-preset";
const VENDOR_KEY = "sk-system-vendor-key";
const PATH = "/internal/llm-proxy/openai-completions/v1/chat/completions";

interface Upstream {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

let originalFetch: typeof fetch;
let upstream: Upstream[];

function completionResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "c1",
      object: "chat.completion",
      model: "upstream-run-model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function seedSystemRun(ctx: TestContext, overrides: Partial<Parameters<typeof seedRun>[0]> = {}) {
  return seedRun({
    packageId: "@test/run-proxy-agent",
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    status: "running",
    runOrigin: "platform",
    modelSource: "system",
    modelId: SYSTEM_PRESET,
    inferenceRoute: "proxy",
    ...overrides,
  });
}

function call(token: string, body: Record<string, unknown>, init: RequestInit = {}) {
  return app.request(PATH, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
}

async function ledgerRows(runId: string) {
  const deadline = Date.now() + 1_000;
  for (;;) {
    const rows = await db.select().from(llmUsage).where(eq(llmUsage.runId, runId));
    if (rows.length > 0 || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function gateModule(calls: BeforeUsageParams[]): AppstrateModule {
  return {
    manifest: { id: "run-proxy-gate", name: "Run Proxy Gate", version: "0.0.0" },
    async init() {},
    hooks: {
      beforeUsage: async (params) => {
        calls.push(params);
        return { code: "quota_exceeded", message: "Credit quota exceeded", status: 402 };
      },
    },
  };
}

function fakeInitCtx(): ModuleInitContext {
  return {
    redisUrl: null,
    appUrl: "http://localhost:3000",
    getSendMail: async () => async () => {},
    getOrgOwnerEmails: async () => [],
    getOrgMembers: async () => [],
    getOrgName: async () => null,
    services: {} as ModuleInitContext["services"],
  };
}

describe("POST /internal/llm-proxy — a run's own inference", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetModules();
    seedTestModelProviders();
    initSystemModelProviderKeys([
      {
        id: "system-run-key",
        providerId: "test-apikey",
        baseUrlOverride: "https://api.openai.test/v1",
        apiKey: VENDOR_KEY,
        models: [
          {
            id: SYSTEM_PRESET,
            modelId: "upstream-run-model",
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          },
          { id: OTHER_PRESET, modelId: "upstream-other-model" },
        ],
      },
    ]);
    ctx = await createTestContext({ orgSlug: "run-llm-proxy" });
    await seedPackage({ id: "@test/run-proxy-agent", orgId: ctx.orgId, type: "agent" });
    upstream = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(input, init);
      upstream.push({
        url: request.url,
        headers: request.headers,
        body: (await request.json()) as Record<string, unknown>,
      });
      return completionResponse();
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(async () => {
    await restoreDiscoveredModules();
    initSystemModelProviderKeys([]);
    seedTestModelProviders();
  });

  it("serves the run's pinned model whatever the body names, and meters it on the run", async () => {
    const run = await seedSystemRun(ctx);
    const res = await call(signRunToken(run.id), {
      model: OTHER_PRESET,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toBe("https://api.openai.test/v1/chat/completions");
    expect(upstream[0]!.body.model).toBe("upstream-run-model");
    expect(upstream[0]!.headers.get("authorization")).toBe(`Bearer ${VENDOR_KEY}`);

    const rows = await ledgerRows(run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "proxy",
      orgId: ctx.orgId,
      credentialSource: "system",
      model: SYSTEM_PRESET,
      inputTokens: 7,
      outputTokens: 2,
      apiKeyId: null,
      userId: null,
    });
  });

  it("applies the proxy's request guards", async () => {
    const run = await seedSystemRun(ctx);
    const res = await call(signRunToken(run.id), {
      model: SYSTEM_PRESET,
      stream: "yes",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(400);
    expect(upstream).toHaveLength(0);
  });

  it("caps the body at LLM_PROXY_LIMITS.max_request_bytes before reading it", async () => {
    const run = await seedSystemRun(ctx);
    const res = await call(signRunToken(run.id), {
      model: SYSTEM_PRESET,
      messages: [{ role: "user", content: "x".repeat(getLlmProxyLimits().max_request_bytes) }],
    });
    expect(res.status).toBe(413);
    expect(upstream).toHaveLength(0);
  });

  it("serves only the inference endpoint", async () => {
    const run = await seedSystemRun(ctx);
    const res = await app.request("/internal/llm-proxy/openai-completions/v1/models", {
      headers: { authorization: `Bearer ${signRunToken(run.id)}` },
    });
    expect(res.status).toBe(404);
    expect(upstream).toHaveLength(0);
  });

  it("refuses a terminal run", async () => {
    const run = await seedSystemRun(ctx, { status: "success" });
    const res = await call(signRunToken(run.id), { model: SYSTEM_PRESET, messages: [] });
    expect(res.status).toBe(403);
    expect(upstream).toHaveLength(0);
  });

  it("refuses an unsigned token and a run that does not exist", async () => {
    expect((await call("run_nope.forged", { model: SYSTEM_PRESET, messages: [] })).status).toBe(
      401,
    );
    expect((await call(signRunToken("run_unknown"), { model: SYSTEM_PRESET })).status).toBe(404);
    expect(upstream).toHaveLength(0);
  });

  it("serves a run on the org's own API key, metered as org spend", async () => {
    const providerKey = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      apiShape: "openai-completions",
      baseUrl: "https://api.openai.test/v1",
      apiKey: "sk-org-own-key",
    });
    const orgModel = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: providerKey.id,
      modelId: "org-upstream-model",
      enabled: true,
    });
    const run = await seedSystemRun(ctx, { modelSource: "org", modelId: orgModel.id });
    const res = await call(signRunToken(run.id), {
      model: SYSTEM_PRESET,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.body.model).toBe("org-upstream-model");
    expect(upstream[0]!.headers.get("authorization")).toBe("Bearer sk-org-own-key");
    const rows = await ledgerRows(run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "proxy", credentialSource: "org", model: orgModel.id });
  });

  it("refuses a run its sidecar serves, and one with no recorded route", async () => {
    // An OAuth subscription run keeps its inference on the sidecar.
    const oauth = await seedSystemRun(ctx, { modelSource: "org", inferenceRoute: "sidecar" });
    // A remote run resolves no platform model: no source, no pinned model.
    const remote = await seedSystemRun(ctx, {
      runOrigin: "remote",
      modelSource: null,
      modelId: null,
      inferenceRoute: null,
    });
    // Launched before the route was recorded.
    const unrouted = await seedSystemRun(ctx, { inferenceRoute: null });
    for (const run of [oauth, remote, unrouted]) {
      const res = await call(signRunToken(run.id), { model: SYSTEM_PRESET, messages: [] });
      expect({ run: run.id, status: res.status }).toEqual({ run: run.id, status: 403 });
    }
    expect(upstream).toHaveLength(0);
  });

  it("refuses another protocol's endpoint without an upstream call", async () => {
    const run = await seedSystemRun(ctx);
    const res = await app.request("/internal/llm-proxy/anthropic-messages/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${signRunToken(run.id)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: SYSTEM_PRESET, max_tokens: 16, messages: [] }),
    });
    expect(res.status).toBe(400);
    expect(upstream).toHaveLength(0);
  });

  it("streams SSE through and meters the usage frame on the run", async () => {
    globalThis.fetch = (async () =>
      new Response(
        `data: {"id":"c1","object":"chat.completion.chunk","model":"upstream-run-model","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n` +
          `data: {"id":"c1","object":"chat.completion.chunk","model":"upstream-run-model","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n` +
          `data: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch;
    const run = await seedSystemRun(ctx);
    const res = await call(signRunToken(run.id), {
      model: SYSTEM_PRESET,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain('"content":"ok"');

    const rows = await ledgerRows(run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ credentialSource: "system", inputTokens: 12, outputTokens: 4 });
  });

  it("does not re-quote the inference of a run admitted at launch, whoever's key it spends", async () => {
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(calls)], fakeInitCtx());
    const providerKey = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      apiShape: "openai-completions",
      baseUrl: "https://api.openai.test/v1",
    });
    const orgModel = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: providerKey.id,
      enabled: true,
    });
    const runs = [
      await seedSystemRun(ctx),
      await seedSystemRun(ctx, { modelSource: "org", modelId: orgModel.id }),
    ];
    for (const run of runs) {
      const res = await call(signRunToken(run.id), {
        model: SYSTEM_PRESET,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.status).toBe(200);
    }
    expect(calls).toEqual([]);
  });
});
