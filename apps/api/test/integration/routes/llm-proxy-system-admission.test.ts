// SPDX-License-Identifier: Apache-2.0

/**
 * System-model proxy path: remote runs only discover their model at inference
 * time, so `/api/llm-proxy` must gate the resolved system preset before
 * upstream spend. The same path also forces OpenAI-compatible streaming usage
 * on the wire and stamps the resulting ledger row as platform-paid.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { llmUsage } from "@appstrate/db/schema";
import type {
  AppstrateModule,
  BeforeUsageParams,
  ModuleInitContext,
  UsageRejection,
} from "@appstrate/core/module";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedApiKey, seedPackage, seedRun } from "../../helpers/seed.ts";
import { updateRun } from "../../../src/services/state/runs.ts";
import {
  getSystemModels,
  initSystemModelProviderKeys,
} from "../../../src/services/model-registry.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { loadModulesFromInstances, resetModules } from "../../../src/lib/modules/module-loader.ts";
import { mintLoopbackToken } from "../../../../../packages/module-chat/src/loopback-auth.ts";

const app = getTestApp();
const SYSTEM_PRESET = "system-proxy-test";

function fakeInitCtx(): ModuleInitContext {
  return {
    redisUrl: null,
    appUrl: "http://localhost:3000",
    getSendMail: async () => () => {},
    getOrgAdminEmails: async () => [],
    services: {} as ModuleInitContext["services"],
  };
}

function gateModule(result: UsageRejection | null, calls: BeforeUsageParams[]): AppstrateModule {
  return {
    manifest: { id: "system-proxy-gate", name: "System Proxy Gate", version: "0.0.0" },
    async init() {},
    hooks: {
      beforeUsage: async (params) => {
        calls.push(params);
        return result;
      },
    },
  };
}

interface Harness {
  ctx: TestContext;
  apiKey: string;
  runId: string;
}

async function buildHarness(): Promise<Harness> {
  const ctx = await createTestContext({ orgSlug: "system-proxy-admission" });
  const key = await seedApiKey({
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    createdBy: ctx.user.id,
    scopes: ["llm-proxy:call"],
  });
  const pkg = await seedPackage({
    id: "@system/proxy-agent",
    orgId: ctx.orgId,
    type: "agent",
  });
  // Remote origin — the run shape this admission seam exists for. Platform
  // runs are admitted once at preflight and skip the proxy-side hook.
  const run = await seedRun({
    packageId: pkg.id,
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    status: "running",
    runOrigin: "remote",
  });
  return { ctx, apiKey: key.rawKey, runId: run.id };
}

function headers(h: Harness, withRun = true): Record<string, string> {
  return {
    authorization: `Bearer ${h.apiKey}`,
    "x-org-id": h.ctx.orgId,
    "x-application-id": h.ctx.defaultAppId,
    "content-type": "application/json",
    ...(withRun ? { "x-run-id": h.runId } : {}),
  };
}

let originalFetch: typeof fetch;

describe("POST /api/llm-proxy — system admission and streaming usage", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetModules();
    seedTestModelProviders();
    initSystemModelProviderKeys([
      {
        id: "system-proxy-key",
        providerId: "test-apikey",
        baseUrlOverride: "https://api.openai.test/v1",
        apiKey: "sk-system-test",
        models: [
          {
            id: SYSTEM_PRESET,
            modelId: "upstream-system-model",
            cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    ]);
    expect(getSystemModels().has(SYSTEM_PRESET)).toBe(true);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    resetModules();
    initSystemModelProviderKeys([]);
    seedTestModelProviders();
  });

  it("returns the module's 402 for a remote run before any upstream request", async () => {
    const h = await buildHarness();
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances(
      [
        gateModule(
          { code: "quota_exceeded", message: "Credit quota exceeded", status: 402 },
          calls,
        ),
      ],
      fakeInitCtx(),
    );

    let upstreamHit = false;
    globalThis.fetch = (async () => {
      upstreamHit = true;
      return new Response("must not be called", { status: 599 });
    }) as unknown as typeof fetch;

    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: headers(h),
      body: JSON.stringify({
        model: SYSTEM_PRESET,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(402);
    expect(upstreamHit).toBe(false);
    expect(calls).toEqual([
      {
        orgId: h.ctx.orgId,
        context: "run",
        packageId: "@system/proxy-agent",
        runningCount: 1,
        // The seam only runs for a resolved system preset, so the call being
        // admitted is platform-funded inference whatever the run declared.
        credentialSource: "system",
        // Remote origin — the platform funds no compute for this run.
        executionPlane: "remote",
        // The proxy holds no manifest: "contribute no compute component here",
        // never a guessed duration (which would double-count).
        timeoutSeconds: null,
      },
    ]);
  });

  it("does not re-dispatch beforeUsage for a platform-origin SYSTEM run (model component already quoted at preflight)", async () => {
    // Same rejecting module as the remote-run 402 test — but the run is
    // platform-origin AND system-credential, so its MODEL component was already
    // quoted when the run was admitted. Re-dispatching would gate the same
    // platform-supplied inference twice: the call reaches upstream and the hook
    // records zero dispatches.
    const h = await buildHarness();
    const platformRun = await seedRun({
      packageId: "@system/proxy-agent",
      orgId: h.ctx.orgId,
      applicationId: h.ctx.defaultAppId,
      status: "running",
      runOrigin: "platform",
      modelSource: "system",
    });
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances(
      [
        gateModule(
          { code: "quota_exceeded", message: "Credit quota exceeded", status: 402 },
          calls,
        ),
      ],
      fakeInitCtx(),
    );

    let upstreamHit = false;
    globalThis.fetch = (async () => {
      upstreamHit = true;
      return new Response(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          model: "upstream-system-model",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: { ...headers(h, false), "x-run-id": platformRun.id },
      body: JSON.stringify({
        model: SYSTEM_PRESET,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstreamHit).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("dispatches beforeUsage for platform runs whose model component was quoted at zero (BYOK-run-as-billing-context bypass)", async () => {
    // THE bypass this seam defends against: a platform BYOK run (or a
    // legacy/unresolved row) was admitted at preflight with a ZERO model
    // component — correct, since its own inference spends the org's credential.
    // Attaching that active run id to a raw SYSTEM-preset proxy request would
    // otherwise launder platform-funded inference through a run quoted at zero
    // and defeat a quota rejection. Both must be admitted here, like a remote
    // run. (The `admittedAtPreflight` expression is unchanged by the
    // fact-reporting refactor, but its justification is now this one.)
    const h = await buildHarness();
    const byokRun = await seedRun({
      packageId: "@system/proxy-agent",
      orgId: h.ctx.orgId,
      applicationId: h.ctx.defaultAppId,
      status: "running",
      runOrigin: "platform",
      modelSource: "org",
    });
    const unresolvedRun = await seedRun({
      packageId: "@system/proxy-agent",
      orgId: h.ctx.orgId,
      applicationId: h.ctx.defaultAppId,
      status: "running",
      runOrigin: "platform",
      modelSource: null,
    });
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances(
      [
        gateModule(
          { code: "quota_exceeded", message: "Credit quota exceeded", status: 402 },
          calls,
        ),
      ],
      fakeInitCtx(),
    );

    let upstreamHits = 0;
    globalThis.fetch = (async () => {
      upstreamHits += 1;
      return new Response("must not be called", { status: 599 });
    }) as unknown as typeof fetch;

    for (const runId of [byokRun.id, unresolvedRun.id]) {
      const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
        method: "POST",
        headers: { ...headers(h, false), "x-run-id": runId },
        body: JSON.stringify({
          model: SYSTEM_PRESET,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(402);
    }

    expect(upstreamHits).toBe(0);
    // Platform origin → `executionPlane: "platform"`, but `timeoutSeconds: null`
    // so the module quotes NO compute component here: that run's compute was
    // already quoted at its own preflight.
    const expectedCall: BeforeUsageParams = {
      orgId: h.ctx.orgId,
      context: "run",
      packageId: "@system/proxy-agent",
      runningCount: 3,
      credentialSource: "system",
      executionPlane: "platform",
      timeoutSeconds: null,
    };
    expect(calls).toEqual([expectedCall, expectedCall]);
  });

  it("does not re-dispatch beforeUsage for a first-party chat loopback call (already admitted at turn start)", async () => {
    // The chat surface owns the hook at turn admission (`checkUsageAllowed`),
    // which now fires for every turn — system or org credential. The signed
    // loopback identity is still load-bearing here (it is what distinguishes
    // chat from an unattributed raw proxy call), but dispatching again would
    // gate the same turn twice.
    const h = await buildHarness();
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances(
      [
        gateModule(
          { code: "quota_exceeded", message: "Credit quota exceeded", status: 402 },
          calls,
        ),
      ],
      fakeInitCtx(),
    );

    let upstreamHit = false;
    globalThis.fetch = (async () => {
      upstreamHit = true;
      return new Response(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          model: "upstream-system-model",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const loopback = mintLoopbackToken(
      {
        userId: h.ctx.user.id,
        email: h.ctx.user.email ?? "u@test",
        name: h.ctx.user.name ?? "U",
        orgId: h.ctx.orgId,
        orgRole: "owner",
      },
      { chatSessionId: "chs_loopback" },
    );

    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${loopback}`,
        "x-org-id": h.ctx.orgId,
        "x-application-id": h.ctx.defaultAppId,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: SYSTEM_PRESET,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstreamHit).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("refuses an unattributed raw system call while leaving BYOK semantics untouched", async () => {
    const h = await buildHarness();
    await loadModulesFromInstances([gateModule(null, [])], fakeInitCtx());

    let upstreamHit = false;
    globalThis.fetch = (async () => {
      upstreamHit = true;
      return new Response("must not be called", { status: 599 });
    }) as unknown as typeof fetch;

    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: headers(h, false),
      body: JSON.stringify({
        model: SYSTEM_PRESET,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "usage_context_required",
    });
    expect(upstreamHit).toBe(false);
  });

  it("refuses to reuse a terminal run as a system-model billing context", async () => {
    const h = await buildHarness();
    await loadModulesFromInstances([gateModule(null, [])], fakeInitCtx());
    await updateRun({ orgId: h.ctx.orgId, applicationId: h.ctx.defaultAppId }, h.runId, {
      status: "success",
    });

    let upstreamHit = false;
    globalThis.fetch = (async () => {
      upstreamHit = true;
      return new Response("must not be called", { status: 599 });
    }) as unknown as typeof fetch;

    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: headers(h),
      body: JSON.stringify({
        model: SYSTEM_PRESET,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(400);
    expect(upstreamHit).toBe(false);
  });

  it("forces include_usage and records an allowed remote system stream", async () => {
    const h = await buildHarness();
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());

    let forwardedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_input, init) => {
      forwardedBody = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as Record<
        string,
        unknown
      >;
      const sse =
        `data: {"id":"c1","object":"chat.completion.chunk","model":"upstream-system-model","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n` +
        `data: {"id":"c1","object":"chat.completion.chunk","model":"upstream-system-model","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n` +
        `data: [DONE]\n\n`;
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: headers(h),
      body: JSON.stringify({
        model: SYSTEM_PRESET,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(forwardedBody).toMatchObject({
      model: "upstream-system-model",
      stream_options: { include_usage: true },
    });
    expect(calls).toHaveLength(1);

    const deadline = Date.now() + 1_000;
    let row: typeof llmUsage.$inferSelect | undefined;
    while (Date.now() < deadline) {
      [row] = await db.select().from(llmUsage).where(eq(llmUsage.runId, h.runId)).limit(1);
      if (row) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(row).toBeDefined();
    expect(row!.credentialSource).toBe("system");
    expect(row!.inputTokens).toBe(12);
    expect(row!.outputTokens).toBe(4);
  });
});
