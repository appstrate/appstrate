// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end coverage for `handleChatStream` — the ai-sdk chat path exercised
 * with a fully scripted platform, no network and no real provider.
 *
 * The handler builds `platformFetch` from `deps.dispatch` and threads it into
 * every platform read (`/api/models`, `/api/me/context`), the platform MCP
 * handshake (`/api/mcp/o/:org`), AND the model inference call
 * (`/api/llm-proxy/…/chat/completions`). So a single in-memory `dispatch` can
 * drive the whole turn deterministically:
 *
 *   - `/api/models`                → one openai-completions model (llm-proxy)
 *   - `/api/mcp/o/:org`            → minimal Streamable-HTTP MCP: initialize +
 *                                    empty tools list (the "no tools" path)
 *   - `/api/me/context`            → a small caller-context payload
 *   - `…/chat/completions` (POST)  → an OpenAI-style SSE text completion; the
 *                                    request body is captured for assertions
 *
 * This exercises the cache-controlled system prompt end-to-end: the system rides
 * via the canonical `instructions` field as a `SystemModelMessage` object (see
 * `aiSdkCachedSystemMessage`), which ai@7 prepends to the model prompt as the
 * first `role:"system"` message. Asserting the stream reaches `finish` with NO
 * error part AND that the wire body's first message is the system prompt
 * exercises the real `streamText` → `toUIMessageStreamResponse` assembly, and the
 * persisted assistant turn proves the `onEnd` / `messageMetadata` finalize path
 * ran.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatMessages, chatSessions } from "@appstrate/db/schema";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../../apps/api/test/helpers/auth.ts";
import { handleChatStream, type ChatEnv } from "../src/chat-stream.ts";
import { mintSessionId } from "../src/session-id.ts";
import { buildChatPlatformDeps } from "../src/platform-services.ts";
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

// A distinctive marker in the scripted MCP `instructions` so we can prove the
// server instructions were fetched and appended to the system prompt.
const MCP_INSTRUCTIONS_MARKER = "SCRIPTED_MCP_INSTRUCTIONS_MARKER";
// A distinctive marker in the scripted caller context so we can prove
// `/api/me/context` was fetched and rendered into the system prompt.
const CONTEXT_ORG_MARKER = "ChatHandlerTestOrg";

const APP_ID = "app_chat_handler_test";
const MODEL_PRESET_ID = "model_chat_handler_test";

/** One scripted openai-completions model row, as `/api/models` returns it. */
function modelsResponse(): Response {
  return Response.json({
    models: [
      {
        id: MODEL_PRESET_ID,
        modelId: "gpt-4o-mini",
        apiShape: "openai-completions",
        enabled: true,
        is_default: true,
      },
    ],
  });
}

/** A minimal but non-empty `/api/me/context` payload. */
function contextResponse(): Response {
  return Response.json({
    user: { name: "Chat Tester", email: "chat-tester@test.com" },
    org: { role: "owner", name: CONTEXT_ORG_MARKER, slug: "chat-handler-test" },
    connections: [],
    agents: [],
    skills: [],
    recent_runs: [],
  });
}

/**
 * Minimal Streamable-HTTP MCP server: answers `initialize` (advertising the
 * `tools` capability + instructions) and `tools/list` (empty). A GET returns
 * 405 so the client's best-effort inbound SSE probe is a clean no-op. This is
 * the supported "module present, zero tools" path — enough to satisfy the
 * ai-sdk path's hard MCP requirement without any real tools.
 */
async function mcpDispatch(req: Request): Promise<Response> {
  if (req.method === "GET") return new Response(null, { status: 405 });
  if (req.method === "DELETE") return new Response(null, { status: 202 });
  const msg = (await req.json()) as { id?: unknown; method?: string };
  // Notifications (no id) — 202, nothing to answer.
  if (!("id" in msg) || msg.id === undefined) return new Response(null, { status: 202 });
  if (msg.method === "initialize") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "scripted-platform-mcp", version: "1.0.0" },
          instructions: MCP_INSTRUCTIONS_MARKER,
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "sess_test" },
      },
    );
  }
  if (msg.method === "tools/list") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** An OpenAI chat-completions SSE stream: role, two text deltas, stop + usage. */
function openAiSse(): Response {
  const frames = [
    `data: {"id":"c1","object":"chat.completion.chunk","model":"${MODEL_PRESET_ID}","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","model":"${MODEL_PRESET_ID}","choices":[{"index":0,"delta":{"content":"Bonjour"},"finish_reason":null}]}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","model":"${MODEL_PRESET_ID}","choices":[{"index":0,"delta":{"content":" le monde"},"finish_reason":null}]}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","model":"${MODEL_PRESET_ID}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n`,
    `data: [DONE]\n\n`,
  ].join("");
  return new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface DispatchCapture {
  inferenceBody: {
    messages?: Array<{ role: string; content: unknown }>;
    stream_options?: { include_usage?: boolean };
  } | null;
  inferenceUrl: string | null;
}

/** Build the scripted in-memory dispatch + a capture handle for assertions. */
function scriptedDispatch(): {
  dispatch: (req: Request) => Promise<Response>;
  capture: DispatchCapture;
} {
  const capture: DispatchCapture = { inferenceBody: null, inferenceUrl: null };
  const dispatch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path.endsWith("/chat/completions")) {
      capture.inferenceUrl = req.url;
      capture.inferenceBody = (await req.json()) as DispatchCapture["inferenceBody"];
      return openAiSse();
    }
    if (path === "/api/models") return modelsResponse();
    if (path === "/api/me/context") return contextResponse();
    if (path.startsWith("/api/mcp/")) return mcpDispatch(req);
    if (path === "/api/applications") {
      return Response.json({ data: [{ id: APP_ID, isDefault: true }] });
    }
    return new Response("unexpected dispatch: " + path, { status: 404 });
  };
  return { dispatch, capture };
}

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

describe("handleChatStream (ai-sdk path)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chat-handler-org" });
  });

  /** A `Hono<ChatEnv>` app mirroring what the platform auth pipeline sets. */
  function buildApp(deps: ReturnType<typeof buildChatPlatformDeps>) {
    const app = new Hono<ChatEnv>();
    app.post("/api/chat", (c) => {
      c.set("orgId", ctx.orgId);
      c.set("user", ctx.user);
      c.set("orgRole", "owner");
      c.set("orgName", ctx.org.name);
      c.set("orgSlug", ctx.org.slug);
      c.set("permissions", new Set<string>());
      return handleChatStream(c, deps);
    });
    return app;
  }

  async function postChat(sessionId: string): Promise<Response> {
    const { dispatch, capture } = scriptedDispatch();
    // buildChatPlatformDeps() with no init ctx → loopback baseline; override
    // dispatch with the scripted one (init would otherwise supply in-process).
    const deps = { ...buildChatPlatformDeps(), dispatch };
    const app = buildApp(deps);
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
      }),
    });
    return Object.assign(res, { capture });
  }

  it("streams start → text → finish with no error and persists the assistant turn", async () => {
    const sessionId = mintSessionId();
    const res = (await postChat(sessionId)) as Response & { capture: DispatchCapture };

    // (1) SSE response.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

    // (2) The chunk sequence: a start, text delta(s), a finish — and NO error
    // chunk. An error chunk here would mean the system-prompt assembly (the
    // `instructions` object) failed to reach the model cleanly.
    const chunks = await collectUiChunks(res);
    const types = chunks.map((c) => c.type);
    expect(types).toContain("start");
    expect(types.filter((t) => t === "text-delta").length).toBeGreaterThan(0);
    expect(types).toContain("finish");
    expect(types.filter((t) => t === "error")).toEqual([]);

    // The visible text reached the client.
    const textParts = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as { delta?: string }).delta ?? "")
      .join("");
    expect(textParts).toContain("Bonjour le monde");

    // (3) The inference request carried the system content as the FIRST message
    // — proving the cache-controlled system-message assembly end-to-end (this is
    // the standardizePrompt path that would have thrown pre-fix).
    const body = res.capture.inferenceBody;
    expect(res.capture.inferenceUrl).toContain(
      "/api/llm-proxy/openai-completions/v1/chat/completions",
    );
    // Streaming usage is opt-in on OpenAI-compatible APIs. This field is
    // load-bearing for the built-in-model billing path: the proxy can only
    // write the chat's llm_usage row when the terminal SSE frame has usage.
    expect(body?.stream_options).toEqual({ include_usage: true });
    expect(body?.messages?.[0]?.role).toBe("system");
    const systemContent = String(body?.messages?.[0]?.content ?? "");
    expect(systemContent).toContain(SYSTEM_PROMPT.slice(0, 64));
    // The platform MCP server instructions + caller context were assembled in.
    expect(systemContent).toContain(MCP_INSTRUCTIONS_MARKER);
    expect(systemContent).toContain(CONTEXT_ORG_MARKER);

    // (4) Wait for the connection-independent persist drain to settle.
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
      metadata?: { appstrate?: { turn?: { engine?: string; finishReason?: string } } };
    };
    const persistedText = (content.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
    expect(persistedText).toContain("Bonjour le monde");

    // (5) The "chat turn done" finalize path ran: the ai-sdk turn metadata was
    // attached via `messageMetadata` (engine + finishReason from onEnd).
    expect(content.metadata?.appstrate?.turn?.engine).toBe("ai-sdk");
    expect(content.metadata?.appstrate?.turn?.finishReason).toBe("stop");

    // (6) The in-flight marker was cleared on finalize (onSettled →
    // clearActiveStream), so the session is no longer "generating".
    const [session] = await db
      .select({ activeStreamId: chatSessions.activeStreamId })
      .from(chatSessions)
      .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.orgId, ctx.orgId)))
      .limit(1);
    expect(session?.activeStreamId).toBeNull();
  }, 20_000);
});
