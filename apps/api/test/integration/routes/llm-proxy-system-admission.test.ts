// SPDX-License-Identifier: Apache-2.0

/**
 * Proxy admission path: remote runs only discover their model at inference
 * time, so `/api/llm-proxy` must gate the resolved preset before upstream
 * spend. The system-preset path also forces OpenAI-compatible streaming usage
 * on the wire and stamps the resulting ledger row as platform-paid.
 *
 * The seam dispatches `beforeUsage` for EVERY call with a usage context, BYOK
 * included — the platform reports `credentialSource` as a fact and the metering
 * module decides. Two invariants are pinned here against regression:
 *   - `usage_context_required` (400) still applies ONLY to platform-supplied
 *     calls; a contextless BYOK call stays allowed (headless BYOK API keys).
 *   - the chat loopback is still admitted once, at turn start, never twice.
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
import {
  seedApiKey,
  seedOrgModel,
  seedOrgModelProviderKey,
  seedPackage,
  seedRun,
} from "../../helpers/seed.ts";
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
    getOrgName: async () => null,
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
  // Remote origin — the run shape that MOST obviously needs this seam (it
  // resolves its model off-platform). Platform-origin runs are gated here too;
  // see the borrowed-run bypass test below.
  const run = await seedRun({
    packageId: pkg.id,
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    status: "running",
    runOrigin: "remote",
  });
  return { ctx, apiKey: key.rawKey, runId: run.id };
}

/**
 * An org-owned (BYOK) preset served by the same `openai-completions` route:
 * the organization's own provider credential, so the resolved model is NOT a
 * system model. Used to prove the seam gates BYOK calls too.
 */
async function seedByokPreset(ctx: TestContext): Promise<string> {
  const providerKey = await seedOrgModelProviderKey({
    orgId: ctx.orgId,
    label: "Org Upstream",
    apiShape: "openai-completions",
    baseUrl: "https://api.openai.test/v1",
    apiKey: "sk-org-byok",
  });
  const model = await seedOrgModel({
    orgId: ctx.orgId,
    credentialId: providerKey.id,
    label: "BYOK Preset",
    modelId: "gpt-4o-2024-08-06",
    enabled: true,
    cost: { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 },
  });
  return model.id;
}

/** Non-streaming upstream reply the openai-completions adapter can parse. */
function completionResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "c1",
      object: "chat.completion",
      model: "gpt-4o-2024-08-06",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
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
        // Derived from the preset THIS call resolved to (a system preset here),
        // not from the credential the referenced run declared.
        credentialSource: "system",
        // Remote origin — the platform funds no compute for this run.
        executionPlane: "remote",
        // The proxy holds no manifest: "contribute no compute component here",
        // never a guessed duration (which would double-count).
        timeoutSeconds: null,
      },
    ]);
  });

  it("refuses the quota bypass that borrows a live platform run's X-Run-Id", async () => {
    // The bypass: an org past its quota (every new run/turn rejected) stamps
    // `X-Run-Id` of a still-alive platform-origin, system-model run onto raw
    // proxy calls. `assertRunAttributable` only binds an API-key principal to
    // org + application, so ANY key of the app can borrow ANY live run — and
    // the proxy used to skip admission entirely for that run shape, buying
    // unbounded platform-paid spend until the borrowed run expired.
    //
    // The run LAUNCH the preflight gate admitted and a raw proxy call are two
    // different billable units (the launch's inference goes through the
    // sidecar and never reaches this route), so the call gets gated here. The
    // preflight quote is also issued exactly once while the number of proxy
    // calls attachable to that run id is unbounded, and the org's balance moves
    // during the run — a launch-time verdict would be stale by now.
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
      return new Response("must not be called", { status: 599 });
    }) as unknown as typeof fetch;

    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: { ...headers(h, false), "x-run-id": platformRun.id },
      body: JSON.stringify({
        model: SYSTEM_PRESET,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(402);
    expect(upstreamHit).toBe(false);
    // …and gated EXACTLY once for the one call — no double dispatch on the
    // legitimate path either.
    expect(calls).toEqual([
      {
        orgId: h.ctx.orgId,
        context: "run",
        packageId: "@system/proxy-agent",
        runningCount: 2,
        // Derived from the resolved preset, not from the RUN's declared
        // credential (`model_source` is "system" here, but it is not read).
        credentialSource: "system",
        // Platform-origin run → the platform hosts the compute.
        executionPlane: "platform",
        // …but this seam owns no compute: that run's compute was quoted at its
        // own preflight. `null` = "contribute no compute component here".
        timeoutSeconds: null,
      },
    ]);
  });

  it("dispatches beforeUsage for BYOK and model-source-less platform runs too", async () => {
    // Gating is independent of the referenced run's persisted `model_source`:
    // the seam never reads it. A platform BYOK run (or a legacy/unresolved row)
    // was admitted at preflight with a ZERO model component — correct, since
    // its own inference spends the org's credential — so attaching that active
    // run id to a raw SYSTEM-preset proxy request would otherwise launder
    // platform-funded inference through a run quoted at zero.
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

  it("dispatches beforeUsage for a BYOK call with a run context, reporting credentialSource 'org'", async () => {
    // The escape this closes: the seam used to return early for any preset that
    // was not system-provided, so a BYOK call never reached the hook at all. The
    // platform was deciding, on the module's behalf, that the operation was
    // free — but it still runs on platform-orchestrated infrastructure, and a
    // module gating on subscription status must be able to refuse it. The
    // platform now reports the FACT (`credentialSource: "org"`) and the module
    // decides; this one allows.
    const h = await buildHarness();
    const byokPreset = await seedByokPreset(h.ctx);
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());

    let upstreamHits = 0;
    globalThis.fetch = (async () => {
      upstreamHits += 1;
      return completionResponse();
    }) as unknown as typeof fetch;

    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: headers(h),
      body: JSON.stringify({
        model: byokPreset,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstreamHits).toBe(1);
    expect(calls).toEqual([
      {
        orgId: h.ctx.orgId,
        context: "run",
        packageId: "@system/proxy-agent",
        runningCount: 1,
        // The org spends its OWN credential — reported, not used to skip.
        credentialSource: "org",
        // The harness run is remote-origin: the caller supplies the host.
        executionPlane: "remote",
        // This seam owns no compute quote (see the system cases above).
        timeoutSeconds: null,
      },
    ]);
  });

  it("lets a metering module refuse a BYOK proxy call", async () => {
    // The product decision this encodes: a BYOK operation for an organization
    // whose subscription is suspended IS blocked. Platform compute is
    // platform-funded, so the module gets to say no — impossible while the
    // platform hid the call from it.
    const h = await buildHarness();
    const byokPreset = await seedByokPreset(h.ctx);
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances(
      [gateModule({ code: "subscription_suspended", message: "Suspended", status: 402 }, calls)],
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
        model: byokPreset,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(402);
    expect(upstreamHit).toBe(false);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { credentialSource: string }).credentialSource).toBe("org");
  });

  it("allows a contextless BYOK call and dispatches nothing (known, deliberate gap)", async () => {
    // `BeforeUsageParams` cannot be built without a context (`packageId` for a
    // run, a session for chat), so a BYOK call with neither X-Run-Id nor the
    // chat loopback has no shape to report — it is admitted undispatched.
    // Requiring a context here instead would turn headless BYOK API-key usage
    // into a 400, which is the regression this pins against.
    const h = await buildHarness();
    const byokPreset = await seedByokPreset(h.ctx);
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());

    let upstreamHits = 0;
    globalThis.fetch = (async () => {
      upstreamHits += 1;
      return completionResponse();
    }) as unknown as typeof fetch;

    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: headers(h, false),
      body: JSON.stringify({
        model: byokPreset,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstreamHits).toBe(1);
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
