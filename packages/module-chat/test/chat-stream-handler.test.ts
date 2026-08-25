// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end coverage for `handleChatStream` with a fully scripted platform: no
 * network, no real provider, no real Pi session.
 *
 * The handler builds `platformFetch` from `deps.dispatch` and threads it into
 * every platform read, so a single in-memory `dispatch` drives the preamble
 * deterministically:
 *
 *   - `/api/models`       → one openai-completions model (llm-proxy-routed)
 *   - `/api/me/context`   → a small caller-context payload
 *   - `/api/applications` → the default application id
 *
 * The engine itself is injected. Production always gets `runPiChat`, which would
 * open a real Pi session against a real provider; here a scripted engine returns
 * the same UI-message-stream contract, so the turn's OWN responsibilities —
 * admission, the model binding it hands the engine, persistence, and the
 * in-flight marker's lifecycle — are asserted without an upstream call. What the
 * engine does with the binding is covered by `pi-chat-model-binding.test.ts` and
 * the Pi mapper/closure suites.
 *
 * NOTE: there is no platform-MCP handshake here. The engine opens its own MCP
 * connection from `platformMcp.url`; the handler only mints the bearer.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatMessages, chatSessions } from "@appstrate/db/schema";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../../apps/api/test/helpers/auth.ts";
import { createUIMessageStreamResponse, type UIMessageChunk } from "ai";
import { handleChatStream, type ChatEngine, type ChatEnv } from "../src/chat-stream.ts";
import { mintSessionId } from "../src/session-id.ts";
import { acquirePiChatSlot, releaseOnClose } from "../src/pi-chat/concurrency.ts";
import type { PiChatInput } from "../src/pi-chat/engine.ts";
import { buildChatPlatformDeps, type ChatPlatformDeps } from "../src/platform-services.ts";
import { buildModuleInitContext } from "../../../apps/api/src/lib/modules/registry.ts";
import { errorHandler } from "../../../apps/api/src/middleware/error-handler.ts";
import { SYSTEM_PROMPT } from "../src/prompt.ts";

/**
 * Wait until the assistant turn is persisted and the in-flight marker cleared.
 * Condition-gated (not a fixed sleep): the connection-independent persist drain
 * runs in a background task, so we poll THIS session's own rows — never the
 * global in-flight registry, which other test files also feed. Resolves as soon
 * as the assistant row lands, so it is fast in the common case and bounded.
 */
async function waitForAssistantPersist(sessionId: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId));
    const hasAssistant = rows.some((r) => (r.content as { role?: string }).role === "assistant");
    if (hasAssistant) {
      const [session] = await db
        .select({ activeStreamId: chatSessions.activeStreamId })
        .from(chatSessions)
        .where(eq(chatSessions.id, sessionId))
        .limit(1);
      if (session && session.activeStreamId == null) return;
    }
    if (Date.now() >= deadline) throw new Error("assistant turn not persisted within timeout");
    await new Promise((r) => setTimeout(r, 15));
  }
}

// A distinctive marker in the scripted caller context so we can prove
// `/api/me/context` was fetched and rendered into the system prompt.
const CONTEXT_ORG_MARKER = "ChatHandlerTestOrg";

const APP_ID = "app_chat_handler_test";
const MODEL_PRESET_ID = "model_chat_handler_test";

/**
 * One scripted openai-completions model row, in the list envelope
 * `/api/models` actually returns (`{ object: "list", data, hasMore }`).
 */
function modelsResponse(apiShape = "openai-completions"): Response {
  return Response.json({
    object: "list",
    hasMore: false,
    data: [
      {
        id: MODEL_PRESET_ID,
        modelId: "gpt-4o-mini",
        apiShape,
        enabled: true,
        is_default: true,
        generation: {
          temperature: "unsupported",
          reasoning: { supported: "unsupported", adaptive: null, levels: {} },
        },
      },
    ],
  });
}

/** A minimal but non-empty `/api/me/context` payload. */
function contextResponse(recentRuns: unknown[] = []): Response {
  return Response.json({
    user: { name: "Chat Tester", email: "chat-tester@test.com" },
    org: { role: "owner", name: CONTEXT_ORG_MARKER, slug: "chat-handler-test" },
    connections: [],
    agents: [],
    skills: [],
    recent_runs: recentRuns,
  });
}

/** Build the scripted in-memory dispatch. Nothing leaves this process. */
function scriptedDispatch(
  apiShape?: string,
  context: () => Response = () => contextResponse(),
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (path === "/api/models") return modelsResponse(apiShape);
    if (path === "/api/me/context") return context();
    if (path === "/api/applications") {
      return Response.json({ data: [{ id: APP_ID, isDefault: true }] });
    }
    return new Response("unexpected dispatch: " + path, { status: 404 });
  };
}

/**
 * A scripted engine: records what the handler handed it, then streams the same
 * chunk sequence the Pi mapper emits for a plain text answer. The concurrency
 * slot is released when the stream closes — exactly as the real engine does, so
 * one test cannot starve the next.
 */
function scriptedEngine(text = "Bonjour le monde"): {
  engine: ChatEngine;
  calls: PiChatInput[];
} {
  const calls: PiChatInput[] = [];
  const engine: ChatEngine = (input) => {
    calls.push(input);
    const id = "txt_1";
    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: "asst_1" },
      { type: "text-start", id },
      { type: "text-delta", id, delta: text },
      { type: "text-end", id },
      { type: "finish", messageMetadata: { appstrate: { turn: TURN_META } } },
    ];
    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    return createUIMessageStreamResponse({
      stream: releaseOnClose(stream, () => input.slot.release()),
    });
  };
  return { engine, calls };
}

/** The turn-metadata fields `turnMetadataFromMessage` requires to decode. */
const TURN_META = {
  finishReason: "stop",
  stepCount: 1,
  maxSteps: 16,
  maxStepsReached: false,
} as const;

/** Parse a UI-message SSE response body into its decoded chunk objects. */
async function collectUiChunks(
  res: Response,
): Promise<Array<{ type: string; [k: string]: unknown }>> {
  const text = await res.text();
  const chunks: Array<{ type: string; [k: string]: unknown }> = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    chunks.push(JSON.parse(data));
  }
  return chunks;
}

describe("handleChatStream", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chat-handler-org" });
  });

  /** A `Hono<ChatEnv>` app mirroring what the platform auth pipeline sets. */
  function buildApp(deps: ReturnType<typeof buildChatPlatformDeps>, engine?: ChatEngine) {
    const app = new Hono<ChatEnv>();
    // Mirror production's RFC 9457 error boundary so invalid client input is
    // asserted at the HTTP contract, not as an uncaught handler exception.
    app.onError((error, context) => errorHandler(error, context as never));
    app.post("/api/chat", (c) => {
      c.set("orgId", ctx.orgId);
      c.set("user", ctx.user);
      c.set("orgRole", "owner");
      c.set("orgName", ctx.org.name);
      c.set("orgSlug", ctx.org.slug);
      c.set("permissions", new Set<string>());
      return handleChatStream(c, deps, engine);
    });
    return app;
  }

  async function postChat(
    sessionId: string,
    generation?: { temperature?: number; reasoningLevel?: string },
    engine?: ChatEngine,
    overrides?: {
      /** apiShape of the single scripted `/api/models` row. */
      apiShape?: string;
      /** Stand in for the platform's credential resolution. */
      resolveChatModel?: ChatPlatformDeps["resolveChatModel"];
      /** Scripted `/api/me/context` body, to vary the payload between turns. */
      context?: () => Response;
    },
  ): Promise<Response> {
    // Real platform deps (the same context `init()` gets), with dispatch
    // overridden by the scripted one so no request leaves this process.
    const deps = {
      ...buildChatPlatformDeps(buildModuleInitContext()),
      dispatch: scriptedDispatch(overrides?.apiShape, overrides?.context),
      ...(overrides?.resolveChatModel ? { resolveChatModel: overrides.resolveChatModel } : {}),
    };
    const app = buildApp(deps, engine);
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-application-id": APP_ID,
        "x-org-id": ctx.orgId,
      },
      body: JSON.stringify({
        id: sessionId,
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "dis bonjour" }] }],
        ...(generation ? { generation } : {}),
      }),
    });
    return res;
  }

  it("rejects generation settings unsupported by the selected model", async () => {
    const { engine, calls } = scriptedEngine();
    const res = await postChat(mintSessionId(), { temperature: 0.4 }, engine);

    expect(res.status).toBe(400);
    // Rejected in the preamble — no turn was ever started.
    expect(calls).toEqual([]);
  });

  it("answers 401 reconnect for a dead oauth credential, before any persistence", async () => {
    const sessionId = mintSessionId();
    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine, {
      apiShape: "anthropic-messages",
      // The platform resolved the row to an oauth2 provider whose credential is
      // revoked or no longer decrypts.
      resolveChatModel: async () => ({ subscription: true, needsReconnection: true }),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type") ?? "").toContain("application/problem+json");
    const body = (await res.json()) as { code?: string };
    // The problem `code` is the whole client contract: `refusalCode()`
    // (`src/turn-error.ts`) reads `status` + `code`, and nothing else.
    expect(body.code).toBe("needs_reconnection");

    // No session would 401 upstream, and nothing was written.
    expect(calls).toEqual([]);
    const rows = await db.select().from(chatMessages).where(eq(chatMessages.sessionId, sessionId));
    expect(rows).toEqual([]);
  });

  it("rejects a model family the engine cannot bind, before any persistence", async () => {
    const sessionId = mintSessionId();
    const { engine, calls } = scriptedEngine();
    // Chat-usable (it is an oauth-subscription shape) but with no llm-proxy
    // route — so an API-key row carrying it resolves to no binding at all.
    const res = await postChat(sessionId, undefined, engine, {
      apiShape: "openai-codex-responses",
    });

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
    const rows = await db.select().from(chatMessages).where(eq(chatMessages.sessionId, sessionId));
    expect(rows).toEqual([]);
  });

  it("ends the turn and clears the in-flight marker when the engine fails", async () => {
    const sessionId = mintSessionId();
    const res = await postChat(sessionId, undefined, () => {
      throw new Error("forced engine failure");
    });

    // A failed turn surfaces as an error — it is never quietly retried on some
    // other loop, which would bill twice and hide the failure.
    expect(res.status).toBe(500);

    // `failCleanup` ran: the session is not left stuck "generating".
    const [session] = await db
      .select({ activeStreamId: chatSessions.activeStreamId })
      .from(chatSessions)
      .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.orgId, ctx.orgId)))
      .limit(1);
    expect(session?.activeStreamId).toBeNull();
  });

  it("rejects a saturated turn before persisting its user message", async () => {
    const previousCap = process.env.CHAT_PI_MAX_CONCURRENCY;
    process.env.CHAT_PI_MAX_CONCURRENCY = "1";
    const heldSlot = acquirePiChatSlot();
    expect(heldSlot).not.toBeNull();

    const sessionId = mintSessionId();
    let engineCalls = 0;
    try {
      const res = await postChat(sessionId, undefined, () => {
        engineCalls += 1;
        throw new Error("the engine must not start while capacity is saturated");
      });

      expect(res.status).toBe(429);
      expect(engineCalls).toBe(0);

      const rows = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, sessionId));
      expect(rows).toEqual([]);
    } finally {
      heldSlot?.release();
      if (previousCap === undefined) delete process.env.CHAT_PI_MAX_CONCURRENCY;
      else process.env.CHAT_PI_MAX_CONCURRENCY = previousCap;
    }
  });

  it("streams start → text → finish, hands the engine a proxy binding, and persists the turn", async () => {
    const sessionId = mintSessionId();
    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine);

    // (1) SSE response.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

    // (2) The chunk sequence reaches the client intact: a start, text delta(s),
    // a finish — and NO error chunk.
    const chunks = await collectUiChunks(res);
    const types = chunks.map((c) => c.type);
    expect(types).toContain("start");
    expect(types.filter((t) => t === "text-delta").length).toBeGreaterThan(0);
    expect(types).toContain("finish");
    expect(types.filter((t) => t === "error")).toEqual([]);

    const textParts = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as { delta?: string }).delta ?? "")
      .join("");
    expect(textParts).toContain("Bonjour le monde");

    // (3) What the handler handed the engine. This is the security-relevant
    // half of the turn: the model row resolved to a PROXY binding carrying the
    // Appstrate preset id and an llm-proxy base URL, never the upstream model id
    // and never a provider secret. (The per-family URL table itself is pinned by
    // `pi-chat-model-binding.test.ts`.)
    expect(calls).toHaveLength(1);
    const input = calls[0]!;
    expect(input.presetId).toBe(MODEL_PRESET_ID);
    expect(input.orgId).toBe(ctx.orgId);
    expect(input.chatSessionId).toBe(sessionId);
    expect(input.modelBinding.authMode).toBe("proxy");
    expect(input.modelBinding.model.id).toBe(MODEL_PRESET_ID);
    expect(input.modelBinding.model.baseUrl).toContain("/api/llm-proxy/openai-completions/v1");
    expect(JSON.stringify(input.modelBinding.model)).not.toContain("gpt-4o-mini");
    // llm-proxy owns the metering for a proxy-bound turn — nothing is recorded
    // inline, so the turn cannot be billed twice.
    expect(input.modelBinding.metering).toEqual({ kind: "proxy" });

    // (4) The system prompt was assembled from the caller context. There are no
    // inline MCP instructions on this path: the engine's own handshake delivers
    // them, and it is handed the org-scoped URL to open it with.
    expect(input.system).toContain(SYSTEM_PROMPT.slice(0, 64));
    expect(input.system).toContain(CONTEXT_ORG_MARKER);
    expect(input.platformMcp.url).toContain(`/api/mcp/o/${encodeURIComponent(ctx.orgId)}`);
    expect(input.platformMcp.headers.Authorization).toMatch(/^Bearer /);
    // The handshake transport is the platform's in-process dispatch, not global
    // `fetch` — three JSON-RPC hops that used to open real loopback sockets back
    // into this same process. Proven by calling it: it answers from the scripted
    // dispatch, which a socket to a non-existent server could not do.
    expect(typeof input.platformMcp.fetch).toBe("function");
    const probed = await input.platformMcp.fetch!(new Request("http://127.0.0.1:1/api/models"));
    expect(probed.status).toBe(200);
    expect(await probed.json()).toMatchObject({ object: "list" });

    // (5) Wait for the connection-independent persist drain to settle.
    await waitForAssistantPersist(sessionId);

    const rows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(asc(chatMessages.seq));
    // The user turn (persisted before inference) + the assistant turn.
    const roles = rows.map((r) => (r.content as { role?: string }).role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");

    const assistant = rows.find((r) => (r.content as { role?: string }).role === "assistant");
    expect(assistant).toBeDefined();
    const content = assistant!.content as {
      parts?: Array<{ type: string; text?: string }>;
      metadata?: { appstrate?: { turn?: { finishReason?: string; stepCount?: number } } };
    };
    const persistedText = (content.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
    expect(persistedText).toContain("Bonjour le monde");

    // (6) The finish chunk's metadata survived the persist drain.
    expect(content.metadata?.appstrate?.turn?.finishReason).toBe("stop");
    expect(content.metadata?.appstrate?.turn?.stepCount).toBe(1);

    // (7) The in-flight marker was cleared on finalize (onSettled →
    // clearActiveStream), so the session is no longer "generating".
    const [session] = await db
      .select({ activeStreamId: chatSessions.activeStreamId })
      .from(chatSessions)
      .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.orgId, ctx.orgId)))
      .limit(1);
    expect(session?.activeStreamId).toBeNull();
  }, 20_000);

  /**
   * The prompt-cache guard.
   *
   * pi-ai emits the system prompt as ONE text block carrying ONE `cache_control`
   * breakpoint, and caching is prefix-based — so any per-turn difference in that
   * block invalidates it AND the conversation-history breakpoint downstream of
   * it. The prompt must therefore be byte-identical between turns for a given
   * caller, whatever the platform reports about their runs in the meantime.
   *
   * This asserts the property at the seam the handler owns, so it fails whatever
   * route a regression takes back in: a re-rendered `recent_runs`, a finer clock,
   * a newly interpolated per-request value.
   */
  it("hands the engine a byte-identical system prompt across turns", async () => {
    const first = scriptedEngine();
    await postChat(mintSessionId(), undefined, first.engine, {
      context: () => contextResponse([]),
    });

    // Same caller, same org — but the platform now reports runs that did not
    // exist a moment ago, each with its own timestamp and error text.
    const second = scriptedEngine();
    await postChat(mintSessionId(), undefined, second.engine, {
      context: () =>
        contextResponse([
          {
            package_id: "@acme/report",
            status: "failed",
            run_number: 41,
            started_at: new Date().toISOString(),
            error: "provider timed out",
          },
          { package_id: "@acme/triage", status: "success", run_number: 42 },
        ]),
    });

    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]!.system).toBe(first.calls[0]!.system);
    // And the volatile payload really was delivered — otherwise the assertion
    // above would pass for the wrong reason (a dispatch that never ran).
    expect(second.calls[0]!.system).not.toContain("provider timed out");
    expect(second.calls[0]!.system).not.toContain("@acme/report");
  }, 20_000);
});
