// SPDX-License-Identifier: Apache-2.0

/**
 * Chat admission gate — `handleChatStream` calls `deps.checkUsageAllowed` for
 * EVERY turn BEFORE it opens an MCP session, persists the user message, or
 * starts inference. A rejection becomes an RFC 9457
 * `application/problem+json` with the hook's status (402 flows through for a
 * soft-cap block).
 *
 * Locked here:
 *   - a gate rejection short-circuits to 402 with NO user message and NO usage
 *     row written (an ephemeral turn writes nothing at all);
 *   - the SUBSCRIPTION branch is gated too, reporting `subscription: true`. It
 *     used to skip admission entirely on the reasoning that it spends the
 *     user's own credential — but the turn is driven by the in-process Pi
 *     engine, so the platform funds its compute, and whether that costs
 *     anything is the metering module's call, not the platform's. A rejection
 *     there must abort before any MCP handshake or user-message persist.
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
import type { ChatModelResolution } from "@appstrate/core/chat-contract";
import type { UsageRejection } from "@appstrate/core/module";
import type { UIMessage } from "ai";

// Boot the shared harness (DB migrations, auth, singletons). The handler is
// invoked directly, but createTestContext needs the initialized platform.
getTestApp();

/**
 * One enabled, chat-usable built-in model — the ai-sdk (non-subscription) path.
 * Shaped as the real `/api/models` list envelope (`listResponse`).
 */
const MODELS_PAYLOAD = {
  object: "list",
  hasMore: false,
  data: [
    {
      id: "sysmodel",
      modelId: "gpt-4o-2024-08-06",
      apiShape: "openai-completions",
      enabled: true,
      is_default: true,
    },
  ],
};

/**
 * A minimal `/api/me/context` payload. The caller-context read is dispatched
 * as soon as the space id is known — concurrently with the model list and
 * ahead of the gate — so the fake must answer it. It is a READ; what a rejected
 * turn must never do is written below (no MCP hop, no message, no usage row).
 */
const CONTEXT_PAYLOAD = {
  user: { name: "U", email: "u@test.com" },
  org: { role: "member", name: "chatgate", slug: "chatgate" },
  connections: [],
  agents: [],
  skills: [],
  recent_runs: [],
};

/** Fake Hono context exposing exactly the reads `handleChatStream` makes. */
function fakeContext(opts: {
  orgId: string;
  user: { id: string; email: string; name: string };
  spaceId: string;
  body: unknown;
}): Context<ChatEnv> {
  const vars: Record<string, unknown> = {
    orgId: opts.orgId,
    user: opts.user,
    // What `enterSpaceContext` writes on every `/api/chat/*` route.
    space: { id: opts.spaceId },
    orgRole: "member",
    permissions: [],
  };
  const headers = new Headers({ "x-space-id": opts.spaceId });
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
  resolveChatModel?: ChatPlatformDeps["resolveChatModel"];
  /** Collects every platform path the turn dispatched (proves no MCP handshake). */
  dispatchPaths?: string[];
}

/**
 * Deps whose `dispatch` serves the two preamble reads (`/api/models`,
 * `/api/me/context`); everything else is scripted.
 */
function fakeDeps(o: DepsOverrides): ChatPlatformDeps {
  return {
    dispatch: async (req) => {
      const path = new URL(req.url).pathname;
      o.dispatchPaths?.push(path);
      if (path === "/api/models") return Response.json(MODELS_PAYLOAD);
      if (path === "/api/me/context") return Response.json(CONTEXT_PAYLOAD);
      return new Response("unexpected dispatch: " + path, { status: 500 });
    },
    rateLimit: () => async (_c, next) => next(),
    resolveChatModel:
      o.resolveChatModel ?? (async (): Promise<ChatModelResolution> => ({ subscription: false })),
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
      spaceId: ctx.defaultSpaceId,
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
      spaceId: ctx.defaultSpaceId,
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

  it("gates the subscription branch too, reporting subscription: true", async () => {
    // The escape this closes: a subscription turn used to skip admission
    // entirely. It reports the one fact this module owns — it chose the
    // in-process engine — and the platform derives `credentialSource: "org"`
    // from it (see apps/api check-usage-allowed.test.ts).
    const gateArgs: Parameters<ChatPlatformDeps["checkUsageAllowed"]>[0][] = [];
    const c = fakeContext({
      orgId: ctx.orgId,
      user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name ?? "U" },
      spaceId: ctx.defaultSpaceId,
      body: { messages: [userTurn("u1", "hello")] },
    });
    // A subscription model whose credential is dead short-circuits to the
    // reconnect response — a clean way to observe the turn past the gate
    // without standing up the Pi engine.
    const res = await handleChatStream(
      c,
      fakeDeps({
        checkUsageAllowed: async (args) => {
          gateArgs.push(args);
          return null;
        },
        resolveChatModel: async (): Promise<ChatModelResolution> => ({
          subscription: true,
          needsReconnection: true,
        }),
      }),
    );

    // Admitted → the turn proceeds and hits the reconnect (401) branch.
    expect(res.status).toBe(401);
    expect(gateArgs).toEqual([
      {
        orgId: ctx.orgId,
        presetId: "sysmodel",
        // Ephemeral turn (no session id in the body) → nothing to attribute.
        sessionId: null,
        subscription: true,
      },
    ]);
  });

  it("a subscription turn blocked by the gate returns 402, opens no MCP session and persists no user message", async () => {
    const sessionId = "chs_gate_subscription";
    const dispatchPaths: string[] = [];
    const c = fakeContext({
      orgId: ctx.orgId,
      user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name ?? "U" },
      spaceId: ctx.defaultSpaceId,
      body: { id: sessionId, messages: [userTurn("u1", "hello")] },
    });
    const res = await handleChatStream(
      c,
      fakeDeps({
        checkUsageAllowed: async () => REJECTION,
        // A LIVE subscription binding: without the gate this turn would go on to
        // drive the in-process Pi engine on platform compute.
        resolveChatModel: async (): Promise<ChatModelResolution> => ({
          subscription: true,
          model: {
            modelId: "claude-sonnet-4-20250514",
            apiShape: "anthropic-messages",
            baseUrl: "https://api.anthropic.test",
            cost: null,
            contextWindow: null,
            maxTokens: null,
            reasoning: false,
            input: null,
            accessToken: "at-test",
          },
        }),
        dispatchPaths,
      }),
    );

    expect(res.status).toBe(402);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "over_cap" });

    // The only platform calls made were the preamble READS — the model list,
    // and the caller-context block that overlaps it. No MCP hop: the Pi engine
    // never started.
    expect(dispatchPaths).toContain("/api/models");
    expect(dispatchPaths.some((p) => p.startsWith("/api/mcp"))).toBe(false);
    expect(dispatchPaths.filter((p) => p !== "/api/models" && p !== "/api/me/context")).toEqual([]);
    // No user message, no metered usage. (The session ROW shell is created
    // before the preamble on purpose — see the ai-sdk case above.)
    const messages = await db
      .select({ seq: chatMessages.seq })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId));
    expect(messages).toHaveLength(0);
    await assertDbCount(llmUsage, eq(llmUsage.orgId, ctx.orgId), 0);
  });
});
