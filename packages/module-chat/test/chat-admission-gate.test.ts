// SPDX-License-Identifier: Apache-2.0

/**
 * Chat admission gate — `handleChatStream` calls `deps.checkUsageAllowed` for
 * the non-subscription (built-in / API-key) branch BEFORE it opens an MCP
 * session, persists the user message, or starts inference. A rejection becomes
 * an RFC 9457 `application/problem+json` with the hook's status (402 flows
 * through for a soft-cap block).
 *
 * Locked here:
 *   - a gate rejection short-circuits to 402 with NO user message and NO usage
 *     row written (an ephemeral turn writes nothing at all);
 *   - the subscription branch is NEVER gated (`checkUsageAllowed` is not even
 *     called) — a subscription turn spends the user's own credential.
 *
 * Style follows the module's other handler tests (caller-context.test.ts): the
 * exported handler is driven directly with a fake Hono context + injected
 * `ChatPlatformDeps` whose `dispatch` serves the platform reads. The DB is real
 * (the harness boots it) so persistence side effects are observable.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "@appstrate/db/client";
import { chatSessions, chatMessages, llmUsage } from "@appstrate/db/schema";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../../apps/api/test/helpers/auth.ts";
import { assertDbCount } from "../../../apps/api/test/helpers/assertions.ts";
import { handleChatStream, type ChatEnv } from "../src/chat-stream.ts";
import type { ChatPlatformDeps } from "../src/platform-services.ts";
import type { SubscriptionChatResolution } from "@appstrate/core/chat-contract";
import type { UsageRejection } from "@appstrate/core/module";
import type { UIMessage } from "ai";

// Boot the shared harness (DB migrations, auth, singletons). The handler is
// invoked directly, but createTestContext needs the initialized platform.
getTestApp();

/** One enabled, chat-usable built-in model — the ai-sdk (non-subscription) path. */
const MODELS_PAYLOAD = {
  models: [
    {
      id: "sysmodel",
      modelId: "gpt-4o-2024-08-06",
      apiShape: "openai-completions",
      enabled: true,
      is_default: true,
    },
  ],
};

/** Fake Hono context exposing exactly the reads `handleChatStream` makes. */
function fakeContext(opts: {
  orgId: string;
  user: { id: string; email: string; name: string };
  applicationId: string;
  body: unknown;
}): Context<ChatEnv> {
  const vars: Record<string, unknown> = {
    orgId: opts.orgId,
    user: opts.user,
    orgRole: "member",
    permissions: [],
  };
  const headers = new Headers({ "x-application-id": opts.applicationId });
  return {
    get: (k: string) => vars[k],
    req: {
      json: async () => opts.body,
      header: (name: string) => headers.get(name) ?? undefined,
    },
  } as unknown as Context<ChatEnv>;
}

interface DepsOverrides {
  checkUsageAllowed: ChatPlatformDeps["checkUsageAllowed"];
  resolveSubscriptionChatModel?: ChatPlatformDeps["resolveSubscriptionChatModel"];
}

/** Deps whose `dispatch` serves `/api/models`; everything else is scripted. */
function fakeDeps(o: DepsOverrides): ChatPlatformDeps {
  return {
    dispatch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/api/models") return Response.json(MODELS_PAYLOAD);
      return new Response("unexpected dispatch: " + path, { status: 500 });
    },
    rateLimit: () => async (_c, next) => next(),
    resolveSubscriptionChatModel:
      o.resolveSubscriptionChatModel ??
      (async (): Promise<SubscriptionChatResolution> => ({ subscription: false })),
    recordChatUsage: async () => {},
    checkUsageAllowed: o.checkUsageAllowed,
  };
}

function userTurn(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as UIMessage;
}

const REJECTION: UsageRejection = {
  code: "over_cap",
  message: "Soft cap reached",
  status: 402,
};

describe("chat admission gate (handleChatStream)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatgate" });
  });

  it("an ephemeral turn blocked by the gate returns 402 and persists nothing", async () => {
    let gateCalls = 0;
    const c = fakeContext({
      orgId: ctx.orgId,
      user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name ?? "U" },
      applicationId: ctx.defaultAppId,
      // No `id` → ephemeral turn: `ensureSession` never runs, so a rejected turn
      // is guaranteed to write ZERO rows (session AND message).
      body: { messages: [userTurn("u1", "hello")] },
    });
    const res = await handleChatStream(
      c,
      fakeDeps({
        checkUsageAllowed: async () => {
          gateCalls += 1;
          return REJECTION;
        },
      }),
    );

    expect(res.status).toBe(402);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const body = (await res.json()) as { status: number; code: string };
    expect(body.status).toBe(402);
    expect(body.code).toBe("over_cap");
    expect(gateCalls).toBe(1);

    // Nothing persisted — the gate runs before the MCP session, the user
    // message, and inference.
    await assertDbCount(chatSessions, eq(chatSessions.orgId, ctx.orgId), 0);
    await assertDbCount(llmUsage, eq(llmUsage.orgId, ctx.orgId), 0);
  });

  it("a persisted-session turn blocked by the gate returns 402 and writes no user message or usage row", async () => {
    const sessionId = "chs_gate_persist";
    const c = fakeContext({
      orgId: ctx.orgId,
      user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name ?? "U" },
      applicationId: ctx.defaultAppId,
      body: { id: sessionId, messages: [userTurn("u1", "hello")] },
    });
    const res = await handleChatStream(c, fakeDeps({ checkUsageAllowed: async () => REJECTION }));

    expect(res.status).toBe(402);

    // The user MESSAGE is never written (persistUserMessage runs after the gate)
    // and no usage is metered. The session ROW shell is created up front (before
    // the preamble) to avoid sidebar flicker — that pre-gate `ensureSession` is
    // deliberate, so an empty session with no messages is the expected residue.
    const [session] = await db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId));
    expect(session?.id).toBe(sessionId);
    const messages = await db
      .select({ seq: chatMessages.seq })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId));
    expect(messages).toHaveLength(0);
    await assertDbCount(llmUsage, eq(llmUsage.orgId, ctx.orgId), 0);
  });

  it("does NOT gate the subscription branch (checkUsageAllowed is never called)", async () => {
    let gateCalls = 0;
    const c = fakeContext({
      orgId: ctx.orgId,
      user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name ?? "U" },
      applicationId: ctx.defaultAppId,
      body: { messages: [userTurn("u1", "hello")] },
    });
    // A subscription model whose credential is dead short-circuits to the
    // reconnect response — a clean way to prove the gate was skipped without
    // standing up the Pi engine.
    const res = await handleChatStream(
      c,
      fakeDeps({
        checkUsageAllowed: async () => {
          gateCalls += 1;
          return REJECTION;
        },
        resolveSubscriptionChatModel: async (): Promise<SubscriptionChatResolution> => ({
          subscription: true,
          needsReconnection: true,
        }),
      }),
    );

    // Reconnect (401), NOT a gate (402) — and the gate was never consulted.
    expect(res.status).toBe(401);
    expect(gateCalls).toBe(0);
    await assertDbCount(llmUsage, eq(llmUsage.orgId, ctx.orgId), 0);
  });
});
