// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the Claude Code subscription SDK gateway —
 * `POST /api/llm-proxy/claude-code-sdk/:presetId/*`.
 *
 * Pinned contract:
 *   1. FIRST-PARTY ONLY. An API key (even with `llm-proxy:call`) is refused
 *      403 — a personal subscription is never spendable through a
 *      third-party-distributable credential. Cookie sessions are refused too.
 *   2. The preset MUST be a `claude-code` subscription model; any other
 *      provider is refused 400 (an OAuth subscription token must never be
 *      injected for a non-subscription model).
 *   3. On the happy path the gateway injects the real subscription Bearer
 *      token + the OAuth beta, forwards the body VERBATIM (no model rewrite,
 *      NO "You are Claude Code" forging), and records one `llm_usage` row.
 *
 * The first-party caller is the chat module's in-process loopback bearer —
 * minted here with the same process-local secret the auth strategy verifies.
 * `globalThis.fetch` is stubbed so no real Anthropic traffic leaves the test.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { llmUsage } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { seedApiKey, seedOrgModelProviderOAuth, seedOrgModel } from "../../helpers/seed.ts";
import { mintLoopbackToken } from "../../../../../packages/module-chat/src/loopback-auth.ts";

const app = getTestApp();

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let originalFetch: typeof fetch;
function mockUpstream(impl: FetchImpl): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
}
function restoreFetch(): void {
  if (originalFetch) globalThis.fetch = originalFetch;
}

interface Harness {
  ctx: TestContext;
  presetId: string;
  loopback: string;
}

async function buildClaudeCodeHarness(): Promise<Harness> {
  const ctx = await createTestContext({ orgSlug: "ccsdkorg" });
  const cred = await seedOrgModelProviderOAuth({
    orgId: ctx.orgId,
    providerId: "claude-code",
    accessToken: "sk-ant-oat-REAL-SUBSCRIPTION",
    expiresAt: Date.now() + 3_600_000, // fresh → resolver returns it without refreshing
  });
  const model = await seedOrgModel({
    orgId: ctx.orgId,
    credentialId: cred.id,
    label: "Claude Code (sub)",
    modelId: "claude-haiku-4-5",
    enabled: true,
    cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
  });
  const loopback = mintLoopbackToken({
    userId: ctx.user.id,
    email: ctx.user.email ?? "u@test",
    name: ctx.user.name ?? "U",
    orgId: ctx.orgId,
    orgRole: "owner",
  });
  return { ctx, presetId: model.id, loopback };
}

function loopbackHeaders(h: Harness): Record<string, string> {
  return {
    Authorization: `Bearer ${h.loopback}`,
    "X-Org-Id": h.ctx.orgId,
    "Content-Type": "application/json",
  };
}

const messagesBody = (model: string) =>
  JSON.stringify({
    model,
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
  });

describe("Claude Code SDK gateway — first-party gating", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
  });
  afterEach(() => restoreFetch());

  it("refuses an API key with 403 (subscription never spendable via API key)", async () => {
    const h = await buildClaudeCodeHarness();
    const key = await seedApiKey({
      orgId: h.ctx.orgId,
      applicationId: h.ctx.defaultAppId,
      createdBy: h.ctx.user.id,
      scopes: ["llm-proxy:call"],
    });
    let upstreamHit = false;
    mockUpstream(async () => {
      upstreamHit = true;
      return new Response("nope", { status: 599 });
    });

    const res = await app.request(`/api/llm-proxy/claude-code-sdk/${h.presetId}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key.rawKey}`,
        "X-Org-Id": h.ctx.orgId,
        "Content-Type": "application/json",
      },
      body: messagesBody("claude-haiku-4-5"),
    });
    expect(res.status).toBe(403);
    expect(upstreamHit).toBe(false);
  });

  it("refuses a cookie session with 403 (bearer-only)", async () => {
    const h = await buildClaudeCodeHarness();
    const res = await app.request(`/api/llm-proxy/claude-code-sdk/${h.presetId}/v1/messages`, {
      method: "POST",
      headers: {
        Cookie: h.ctx.cookie,
        "X-Org-Id": h.ctx.orgId,
        "Content-Type": "application/json",
      },
      body: messagesBody("claude-haiku-4-5"),
    });
    expect(res.status).toBe(403);
  });
});

describe("Claude Code SDK gateway — first-party happy path", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
  });
  afterEach(() => restoreFetch());

  it("injects the real subscription token + OAuth beta, forwards verbatim (no forge), meters", async () => {
    const h = await buildClaudeCodeHarness();
    let captured: { url: string; headers: Headers; body: string } | null = null;
    mockUpstream(async (input, init) => {
      captured = {
        url: typeof input === "string" ? input : (input as URL).toString(),
        headers: new Headers(init?.headers as Record<string, string>),
        body: new TextDecoder().decode(init?.body as Uint8Array),
      };
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 120, output_tokens: 8 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const res = await app.request(`/api/llm-proxy/claude-code-sdk/${h.presetId}/v1/messages`, {
      method: "POST",
      headers: loopbackHeaders(h),
      body: messagesBody("claude-haiku-4-5"),
    });

    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    // Forwarded to Anthropic's real host (claude-code provider default baseUrl).
    expect(captured!.url).toBe("https://api.anthropic.com/v1/messages");
    // Real subscription token swapped in for the placeholder loopback bearer.
    expect(captured!.headers.get("authorization")).toBe("Bearer sk-ant-oat-REAL-SUBSCRIPTION");
    // OAuth beta added.
    expect(captured!.headers.get("anthropic-beta") ?? "").toContain("oauth-2025-04-20");
    // NO forging: body forwarded verbatim, model NOT rewritten, no CC prelude.
    const forwarded = JSON.parse(captured!.body);
    expect(forwarded.model).toBe("claude-haiku-4-5");
    expect(captured!.body).not.toContain("You are Claude Code");

    // Metered: model = preset id, realModel = upstream id.
    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.orgId, h.ctx.orgId));
    expect(row).toBeDefined();
    expect(row!.model).toBe(h.presetId);
    expect(row!.realModel).toBe("claude-haiku-4-5");
    expect(row!.inputTokens).toBe(120);
    expect(row!.outputTokens).toBe(8);
    expect(row!.userId).toBe(h.ctx.user.id);
  });

  it("acks the SDK connectivity probe (bare HEAD) with 200 and no upstream call", async () => {
    const h = await buildClaudeCodeHarness();
    let upstreamHit = false;
    mockUpstream(async () => {
      upstreamHit = true;
      return new Response("x", { status: 200 });
    });
    const res = await app.request(`/api/llm-proxy/claude-code-sdk/${h.presetId}`, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${h.loopback}`, "X-Org-Id": h.ctx.orgId },
    });
    expect(res.status).toBe(200);
    expect(upstreamHit).toBe(false);
  });

  it("rejects a non-claude-code preset with 400 (no subscription token for it)", async () => {
    const ctx = await createTestContext({ orgSlug: "ccsdkorg2" });
    // An OAuth credential for a DIFFERENT provider (codex).
    const cred = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: "codex",
      accessToken: "tok",
      expiresAt: Date.now() + 3_600_000,
    });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: cred.id,
      label: "Codex",
      modelId: "gpt-5.1-codex",
      enabled: true,
    });
    const loopback = mintLoopbackToken({
      userId: ctx.user.id,
      email: ctx.user.email ?? "u@test",
      name: ctx.user.name ?? "U",
      orgId: ctx.orgId,
      orgRole: "owner",
    });
    let upstreamHit = false;
    mockUpstream(async () => {
      upstreamHit = true;
      return new Response("x", { status: 200 });
    });

    const res = await app.request(`/api/llm-proxy/claude-code-sdk/${model.id}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${loopback}`,
        "X-Org-Id": ctx.orgId,
        "Content-Type": "application/json",
      },
      body: messagesBody("gpt-5.1-codex"),
    });
    expect(res.status).toBe(400);
    expect(upstreamHit).toBe(false);
  });
});
