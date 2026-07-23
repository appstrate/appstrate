// SPDX-License-Identifier: Apache-2.0

/**
 * Chat attribution on the built-in (ai-sdk → llm-proxy) path.
 *
 * The chat session id is NOT a spoofable header: chat mints a `chatloop_`
 * inference bearer whose SIGNED claims carry the session id (loopback-auth.ts).
 * The llm-proxy reads it from the validated token (`authExtra.chatSessionId`)
 * and stamps `llm_usage.chat_session_id`. This drives one real proxy call with
 * such a token and asserts the row is attributed to the chat session and stamped
 * with the credential source — with NO run id (a proxy row is single-context).
 *
 * Runs from the module's root so the chat module (and thus its chat-loopback
 * auth strategy) is loaded in the shared test app; the minter is imported
 * directly because it signs with the module's process-local secret.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { llmUsage, chatSessions } from "@appstrate/db/schema";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../../apps/api/test/helpers/auth.ts";
import { flushRedis } from "../../../apps/api/test/helpers/redis.ts";
import { seedOrgModelProviderKey, seedOrgModel } from "../../../apps/api/test/helpers/seed.ts";
import { mintLoopbackToken } from "../src/loopback-auth.ts";

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

async function waitForRow<T>(query: () => Promise<T[]>): Promise<T> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const rows = await query();
    if (rows.length > 0) return rows[0]!;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitForRow: row never materialised");
}

describe("chat ai-sdk path — session attribution via the loopback bearer", () => {
  let ctx: TestContext;
  let presetId: string;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "chatattr" });
    const providerKey = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      apiShape: "openai-completions",
      baseUrl: "https://api.openai.test/v1",
      apiKey: "sk-upstream-attr",
    });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: providerKey.id,
      modelId: "gpt-4o-2024-08-06",
      enabled: true,
      cost: { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 },
    });
    presetId = model.id;
  });

  afterEach(() => restoreFetch());

  it("stamps chat_session_id (from the signed token) and credential_source, with no run id", async () => {
    // The FK target for the attribution — a persisted chat session.
    await db.insert(chatSessions).values({
      id: "chs_attr_1",
      orgId: ctx.orgId,
      userId: ctx.user.id,
    });

    mockUpstream(
      async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl_attr",
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 20, completion_tokens: 8 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    // The exact bearer chat mints for its ai-sdk inference calls: identity +
    // the session id signed INTO the claims (never a header).
    const token = mintLoopbackToken(
      {
        userId: ctx.user.id,
        email: ctx.user.email,
        name: ctx.user.name,
        orgId: ctx.orgId,
        orgRole: "member",
      },
      { chatSessionId: "chs_attr_1" },
    );

    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Org-Id": ctx.orgId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: presetId, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);

    const row = await waitForRow(() =>
      db.select().from(llmUsage).where(eq(llmUsage.orgId, ctx.orgId)).limit(1),
    );
    expect(row.chatSessionId).toBe("chs_attr_1");
    expect(row.runId).toBeNull();
    // Org-owned preset (org provider key) → the org's own credential reached the
    // provider, so the row is stamped "org".
    expect(row.credentialSource).toBe("org");
    expect(row.inputTokens).toBe(20);
    expect(row.model).toBe(presetId);
  });

  it("records un-attributed usage (no chat_session_id) when the token carries none", async () => {
    mockUpstream(
      async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl_attr2",
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 7, completion_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    // An ephemeral turn mints the bearer WITHOUT a session id — usage is still
    // metered, but attributed to no context.
    const token = mintLoopbackToken({
      userId: ctx.user.id,
      email: ctx.user.email,
      name: ctx.user.name,
      orgId: ctx.orgId,
      orgRole: "member",
    });

    const res = await app.request("/api/llm-proxy/openai-completions/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Org-Id": ctx.orgId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: presetId, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);

    const row = await waitForRow(() =>
      db.select().from(llmUsage).where(eq(llmUsage.orgId, ctx.orgId)).limit(1),
    );
    expect(row.chatSessionId).toBeNull();
    expect(row.runId).toBeNull();
    expect(row.credentialSource).toBe("org");
  });
});
