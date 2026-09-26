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
 *   - `/api/spaces` → the default space id
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
import {
  CHAT_MESSAGE_MAX_BYTES,
  handleChatStream,
  type ChatEngine,
  type ChatEnv,
} from "../src/chat-stream.ts";
import { mintSessionId } from "../src/session-id.ts";
import { acquirePiChatSlot, releaseOnClose } from "../src/pi-chat/concurrency.ts";
import type { PiChatInput } from "../src/pi-chat/engine.ts";
import type { ChatAttachmentRequest } from "@appstrate/core/chat-contract";
import type { ModuleInitContext, PrincipalKind } from "@appstrate/core/module";
import { buildChatPlatformDeps, type ChatPlatformDeps } from "../src/platform-services.ts";
import { buildModuleInitContext } from "../../../apps/api/src/lib/modules/registry.ts";
import { errorHandler } from "../../../apps/api/src/middleware/error-handler.ts";
import { initSystemModelProviderKeys } from "../../../apps/api/src/services/model-registry.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { turnCapabilities } from "../src/capabilities.ts";
import { chatLoopbackStrategy } from "../src/loopback-auth.ts";
import { _resetChatEnvForTests } from "../src/env.ts";

// The chat handler reads the system model registry; the HTTP harness initializes it at boot.
initSystemModelProviderKeys();

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

const SPACE_ID = "spc_chat_handler_test";
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
    if (path === "/api/spaces") {
      return Response.json({ data: [{ id: SPACE_ID, isDefault: true }] });
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

/** The permission set the turn's platform-MCP bearer actually carries. */
async function tokenPermissions(input: PiChatInput): Promise<string[]> {
  const authorization = input.platformMcp?.headers?.Authorization;
  expect(typeof authorization).toBe("string");
  const resolved = await chatLoopbackStrategy.authenticate({
    headers: new Headers({ authorization: authorization as string }),
  } as never);
  expect(resolved).not.toBeNull();
  return [...(resolved!.permissions ?? [])].sort();
}

describe("handleChatStream", () => {
  let ctx: TestContext;
  /** What `app.onError` saw, so a thrown invariant can be asserted on its message. */
  let handlerError: Error | null = null;

  beforeEach(async () => {
    await truncateAll();
    handlerError = null;
    ctx = await createTestContext({ orgSlug: "chat-handler-org" });
  });

  /** A `Hono<ChatEnv>` app mirroring what the platform auth pipeline sets. */
  function buildApp(
    deps: ReturnType<typeof buildChatPlatformDeps>,
    engine?: ChatEngine,
    permissions: Set<string> = new Set<string>(),
    principalKind: PrincipalKind = "user",
  ) {
    const app = new Hono<ChatEnv>();
    // Mirror production's RFC 9457 error boundary so invalid client input is
    // asserted at the HTTP contract, not as an uncaught handler exception. The
    // boundary renders a non-`ApiError` as a bare 500, so keep the error itself.
    app.onError((error, context) => {
      handlerError = error;
      return errorHandler(error, context as never);
    });
    app.post("/api/chat", (c) => {
      c.set("orgId", ctx.orgId);
      c.set("user", ctx.user);
      // What `enterSpaceContext` writes on every `/api/chat/*` route in
      // production — the session's space and the scope of the turn's reads.
      c.set("space", { id: ctx.defaultSpaceId });
      c.set("principalKind", principalKind);
      c.set("orgRole", "owner");
      c.set("orgName", ctx.org.name);
      c.set("orgSlug", ctx.org.slug);
      c.set("permissions", permissions);
      return handleChatStream(c, deps, engine);
    });
    return app;
  }

  async function postChat(
    sessionId: string,
    generation?: { temperature?: number; reasoning_level?: string },
    engine?: ChatEngine,
    overrides?: {
      /** apiShape of the single scripted `/api/models` row. */
      apiShape?: string;
      /** Stand in for the platform's credential resolution. */
      resolveChatModel?: ChatPlatformDeps["resolveChatModel"];
      /** Scripted `/api/me/context` body, to vary the payload between turns. */
      context?: () => Response;
      /** Replace the whole scripted dispatch (to observe request timing). */
      dispatch?: (req: Request) => Promise<Response>;
      /** Stand in for the platform's composer-attachment resolution. */
      resolveChatAttachment?: ChatPlatformDeps["resolveChatAttachment"];
      /** The caller's resolved RBAC set, as the auth pipeline would write it. */
      permissions?: Set<string>;
      /** Replace the single user message (to carry a composer attachment). */
      parts?: unknown[];
      /** The kind the auth pipeline resolved; production reaches here as `user` only. */
      principalKind?: PrincipalKind;
      /** The composer's agent-authoring switch for this turn; omitted = on. */
      agentAuthoring?: boolean;
      /** Earlier turns replayed ahead of the new user message. */
      history?: unknown[];
      /** Extra body fields, e.g. the picker's `skill_mode` / `pinned_skills`. */
      body?: Record<string, unknown>;
      /** Stand in for the PLATFORM service, so the deps wrapper still runs over it. */
      loadEnforcedChatSkills?: ModuleInitContext["services"]["loadEnforcedChatSkills"];
    },
  ): Promise<Response> {
    // Real platform deps (the same context `init()` gets), with dispatch
    // overridden by the scripted one so no request leaves this process.
    const initCtx = buildModuleInitContext();
    const deps = {
      ...buildChatPlatformDeps(
        overrides?.loadEnforcedChatSkills
          ? {
              ...initCtx,
              services: {
                ...initCtx.services,
                loadEnforcedChatSkills: overrides.loadEnforcedChatSkills,
              },
            }
          : initCtx,
      ),
      dispatch: overrides?.dispatch ?? scriptedDispatch(overrides?.apiShape, overrides?.context),
      ...(overrides?.resolveChatModel ? { resolveChatModel: overrides.resolveChatModel } : {}),
      ...(overrides?.resolveChatAttachment
        ? { resolveChatAttachment: overrides.resolveChatAttachment }
        : {}),
    };
    const app = buildApp(deps, engine, overrides?.permissions, overrides?.principalKind);
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-space-id": SPACE_ID,
        "x-org-id": ctx.orgId,
      },
      body: JSON.stringify({
        id: sessionId,
        messages: [
          ...(overrides?.history ?? []),
          {
            id: "u1",
            role: "user",
            parts: overrides?.parts ?? [{ type: "text", text: "dis bonjour" }],
          },
        ],
        ...(generation ? { generation } : {}),
        ...(overrides?.agentAuthoring === undefined
          ? {}
          : { agent_authoring: overrides.agentAuthoring }),
        ...overrides?.body,
      }),
    });
    return res;
  }

  it("refuses to mint a loopback for a principal that is not the user", async () => {
    // `chat:read`/`chat:write` are neither `apiKeyGrantable` nor
    // `endUserGrantable` (`index.ts`), so nothing but a `user` principal reaches
    // this handler today — and `chatLoopbackStrategy` declares `principalKind:
    // "user"` on that basis. Widening those grants must break here, loudly,
    // rather than hand a key's loopback the creator's personal spaces.
    const { engine, calls } = scriptedEngine();
    const res = await postChat(mintSessionId(), undefined, engine, {
      principalKind: "delegate",
    });

    expect(res.status).toBe(500);
    expect(handlerError?.message).toMatch(/loopback minted for a delegate principal/);
    // Refused before the turn began: no engine call, no persisted session.
    expect(calls).toEqual([]);
  });

  it("hands the composer attachment the caller's own permission set", async () => {
    // The gallery the user picks an `appfile://` from is filtered by
    // `runs:read-all`; the platform resolves the attachment against the same
    // set, so the handler has to carry it. Forwarding nothing would 404 a file
    // the picker had just offered.
    const sessionId = mintSessionId();
    const { engine } = scriptedEngine();
    const requests: ChatAttachmentRequest[] = [];
    const permissions = new Set(["runs:read-all"]);

    const res = await postChat(sessionId, undefined, engine, {
      permissions,
      parts: [
        { type: "text", text: "résume ce fichier" },
        {
          type: "file",
          url: "appfile://file_abcdefgh",
          mediaType: "text/plain",
          filename: "r.txt",
        },
      ],
      resolveChatAttachment: async (request) => {
        requests.push(request);
        return { uri: request.uri, name: "r.txt", mime: "text/plain", size: 12 };
      },
    });

    expect(res.status).toBe(200);
    await collectUiChunks(res);
    expect(requests).toHaveLength(1);
    expect([...requests[0]!.permissions]).toEqual(["runs:read-all"]);
    await waitForAssistantPersist(sessionId);
  });

  it("rejects generation settings unsupported by the selected model", async () => {
    const { engine, calls } = scriptedEngine();
    const res = await postChat(mintSessionId(), { temperature: 0.4 }, engine);

    expect(res.status).toBe(400);
    // Rejected in the preamble — no turn was ever started.
    expect(calls).toEqual([]);
  });

  it("answers 409 reconnect for a dead oauth credential, before any persistence", async () => {
    const sessionId = mintSessionId();
    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine, {
      apiShape: "anthropic-messages",
      // The platform resolved the row to an oauth2 provider whose credential is
      // revoked or no longer decrypts.
      resolveChatModel: async () => ({ subscription: true, needsReconnection: true }),
    });

    // 409, never 401: the caller's own token is valid, so no auth challenge.
    expect(res.status).toBe(409);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
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

  it("rejects a message that is not a UIMessage, before any persistence", async () => {
    const sessionId = mintSessionId();
    const { engine, calls } = scriptedEngine();
    // A text part with no `text`: the old `z.unknown()` let it through and it
    // was stored verbatim, then read back as a trusted `UIMessage`.
    const res = await postChat(sessionId, undefined, engine, { parts: [{ type: "text" }] });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type") ?? "").toContain("application/problem+json");
    expect(calls).toEqual([]);
    const sessions = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
    expect(sessions).toEqual([]);
  });

  it("does not validate earlier turns: a row in an older AI SDK shape still lets the turn run", async () => {
    const sessionId = mintSessionId();
    const { engine, calls } = scriptedEngine();
    // An AI SDK v4 `tool-invocation` part: `safeValidateUIMessages` rejects it.
    const legacy = {
      id: "a0",
      role: "assistant",
      parts: [
        {
          type: "tool-invocation",
          toolInvocation: { state: "result", toolCallId: "c1", toolName: "x", args: {}, result: 1 },
        },
      ],
    };
    const res = await postChat(sessionId, undefined, engine, { history: [legacy] });

    expect(res.status).toBe(200);
    await collectUiChunks(res);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages.map((m) => m.id)).toEqual(["a0", "u1"]);
    await waitForAssistantPersist(sessionId);
  });

  it("rejects a last message over the persisted-content cap, before any persistence", async () => {
    const sessionId = mintSessionId();
    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine, {
      parts: [{ type: "text", text: "x".repeat(CHAT_MESSAGE_MAX_BYTES) }],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail).toContain(`max is ${CHAT_MESSAGE_MAX_BYTES}`);
    expect(calls).toEqual([]);
    const sessions = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
    expect(sessions).toEqual([]);
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
    _resetChatEnvForTests();
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
      expect(res.headers.get("Retry-After")).toBe("5");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ code: "chat_capacity", retry_after: 5 });
      expect(body).not.toHaveProperty("retryAfter");
      expect(body.instance).toStartWith("urn:appstrate:request:");
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
      _resetChatEnvForTests();
    }
  });

  it("without a selection in the body, keeps the stored one: strict injects and withholds `skills:read`", async () => {
    // Persona, context block and token must agree within one turn; all three
    // are wired from the one session-row read, which only this test can prove.
    const sessionId = mintSessionId();
    const PIN = "@acme/pinned-skill";
    await db.insert(chatSessions).values({
      id: sessionId,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      spaceId: ctx.defaultSpaceId,
      title: null,
      skillMode: "strict",
      pinnedSkills: [PIN],
    });

    // The chosen skill is in the space's active listing; record which contents
    // are read, so the rendered block is a function of what the handler read.
    const read: string[] = [];
    const dispatch = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      if (url.pathname === "/api/packages/skills") {
        return Response.json({
          data: [{ id: PIN, name: "Pinned", description: null, version: "1.0.0" }],
        });
      }
      if (url.pathname.startsWith("/api/packages/skills/")) {
        read.push(url.pathname.replace("/api/packages/skills/", ""));
        return Response.json({ content: "Always answer in haiku.", version: "1.0.0" });
      }
      if (url.pathname !== "/api/me/context") return scriptedDispatch()(req);
      return Response.json({
        user: { name: "Chat Tester", email: "chat-tester@test.com" },
        org: { role: "owner", name: CONTEXT_ORG_MARKER, slug: "chat-handler-test" },
        connections: [],
        agents: [],
        // Non-empty on purpose: strict lists no skill, so it must not render.
        skills: [{ packageId: "@acme/catalogued", display_name: "Catalogued" }],
      });
    };

    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine, {
      dispatch,
      // Every `skills:*` is withheld, not only `skills:read`: a write echoes the SKILL.md.
      permissions: new Set([
        "mcp:read",
        "mcp:invoke",
        "skills:read",
        "skills:write",
        "skills:delete",
      ]),
    });
    expect(res.status).toBe(200);
    await collectUiChunks(res);

    expect(read).toEqual([PIN]);
    const input = calls[0]!;
    expect(input.system).toContain(
      `<skill id="${PIN}" version="1.0.0">\nAlways answer in haiku.\n</skill>`,
    );
    expect(input.system).not.toContain("@acme/catalogued");
    // No skill tool is taught, and the token cannot reach one.
    expect(input.system).not.toContain("read_skill");
    expect(input.system).not.toContain("listSkills");
    expect(input.system).toContain("This conversation is restricted to the skills shown here");
    expect(await tokenPermissions(input)).toEqual(["mcp:invoke", "mcp:read"]);

    await waitForAssistantPersist(sessionId);
  });

  it("writes the body's selection on the row it creates, and runs the turn on it", async () => {
    const sessionId = mintSessionId();
    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine, {
      permissions: new Set(["mcp:read", "mcp:invoke", "skills:read"]),
      body: { skill_mode: "strict", pinned_skills: ["@acme/z", "@acme/a", "@acme/z"] },
    });
    expect(res.status).toBe(200);
    await collectUiChunks(res);

    const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
    expect(row?.skillMode).toBe("strict");
    expect(row?.pinnedSkills).toEqual(["@acme/a", "@acme/z"]);
    expect(await tokenPermissions(calls[0]!)).toEqual(["mcp:invoke", "mcp:read"]);

    await waitForAssistantPersist(sessionId);
  });

  it("lets the body's selection replace the stored one", async () => {
    const sessionId = mintSessionId();
    await db.insert(chatSessions).values({
      id: sessionId,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      spaceId: ctx.defaultSpaceId,
      title: null,
      skillMode: "strict",
      pinnedSkills: ["@acme/a"],
    });
    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine, {
      permissions: new Set(["mcp:read", "mcp:invoke", "skills:read"]),
      body: { skill_mode: "auto", pinned_skills: [] },
    });
    expect(res.status).toBe(200);
    await collectUiChunks(res);

    const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
    expect(row?.skillMode).toBe("auto");
    expect(row?.pinnedSkills).toEqual([]);
    expect(await tokenPermissions(calls[0]!)).toContain("skills:read");

    await waitForAssistantPersist(sessionId);
  });

  it("refuses a skill mode without its skills, and the reverse", async () => {
    for (const body of [{ skill_mode: "manual" }, { pinned_skills: ["@acme/a"] }]) {
      const res = await postChat(mintSessionId(), undefined, scriptedEngine().engine, { body });
      expect(res.status).toBe(400);
    }
  });

  it("keeps `skills:read` on the token in manual, where the model may look for more", async () => {
    const sessionId = mintSessionId();
    await db.insert(chatSessions).values({
      id: sessionId,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      spaceId: ctx.defaultSpaceId,
      title: null,
      skillMode: "manual",
      pinnedSkills: [],
    });
    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine, {
      permissions: new Set(["mcp:read", "mcp:invoke", "skills:read"]),
    });
    expect(res.status).toBe(200);
    await collectUiChunks(res);
    expect(await tokenPermissions(calls[0]!)).toEqual(["mcp:invoke", "mcp:read", "skills:read"]);
    expect(calls[0]!.system).toContain("listSkills");

    await waitForAssistantPersist(sessionId);
  });

  it("teaches no skill on a turn without `skills:read`", async () => {
    // The payload below DOES carry skills, so every absence asserted is the
    // turn's own gate, not an empty fixture: neither the persona nor the
    // block names a skill.
    const sessionId = mintSessionId();
    const PIN = "@acme/pinned-skill";
    await db.insert(chatSessions).values({
      id: sessionId,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      spaceId: ctx.defaultSpaceId,
      title: null,
      pinnedSkills: [PIN],
    });
    const skillReads: string[] = [];
    const withSkills = () =>
      Response.json({
        user: { name: "Chat Tester", email: "chat-tester@test.com" },
        org: { role: "owner", name: CONTEXT_ORG_MARKER, slug: "chat-handler-test" },
        connections: [],
        agents: [],
        skills: [{ packageId: "@acme/catalogued", display_name: "Catalogued" }],
      });
    const dispatch = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/packages/skills")) skillReads.push(url.pathname);
      return scriptedDispatch(undefined, withSkills)(req);
    };

    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine, {
      dispatch,
      permissions: new Set(["mcp:read", "mcp:invoke", "agents:read", "agents:run"]),
    });
    expect(res.status).toBe(200);
    await collectUiChunks(res);

    expect(skillReads).toEqual([]);
    const system = calls[0]!.system;
    expect(system).toContain(CONTEXT_ORG_MARKER);
    for (const absent of ["## Skills", PIN, "@acme/catalogued", "read_skill", "listSkills"]) {
      expect(system).not.toContain(absent);
    }

    await waitForAssistantPersist(sessionId);
  });

  describe("space-enforced skills", () => {
    const HOUSE = {
      packageId: "@acme/house",
      name: "House rules",
      version: "2.0.0",
      content: "Always sign with the house motto.",
    };

    it("refuses the turn with a 503 when they cannot be loaded: no message, no marker, no engine", async () => {
      const sessionId = mintSessionId();
      const { engine, calls } = scriptedEngine();
      const res = await postChat(sessionId, undefined, engine, {
        permissions: new Set(["chat:write", "mcp:read", "mcp:invoke"]),
        loadEnforcedChatSkills: async () => {
          throw new Error("storage outage");
        },
      });

      expect(res.status).toBe(503);
      expect(res.headers.get("content-type") ?? "").toContain("application/problem+json");
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("enforced_skills_unavailable");
      // The session row and its selection are upserted, as for every preamble refusal.
      expect(calls).toEqual([]);
      const rows = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, sessionId));
      expect(rows).toEqual([]);
      const [session] = await db
        .select({ activeStreamId: chatSessions.activeStreamId })
        .from(chatSessions)
        .where(eq(chatSessions.id, sessionId));
      expect(session?.activeStreamId ?? null).toBeNull();
    });

    it("refuses before materializing any composer attachment", async () => {
      const sessionId = mintSessionId();
      const resolved: string[] = [];
      const res = await postChat(sessionId, undefined, scriptedEngine().engine, {
        permissions: new Set(["chat:write", "mcp:read", "mcp:invoke"]),
        parts: [
          { type: "text", text: "résume ce fichier" },
          {
            type: "file",
            url: "appfile://file_abcdefgh",
            mediaType: "text/plain",
            filename: "r.txt",
          },
        ],
        resolveChatAttachment: async (request) => {
          resolved.push(request.uri);
          return { uri: request.uri, name: "r.txt", mime: "text/plain", size: 12 };
        },
        loadEnforcedChatSkills: async () => {
          throw new Error("storage outage");
        },
      });
      expect(res.status).toBe(503);
      expect(resolved).toEqual([]);
    });

    it("injects them for a caller who holds `chat:write` and no `skills:*`, in every mode", async () => {
      for (const skillMode of ["auto", "manual", "strict"] as const) {
        const sessionId = mintSessionId();
        const loaded: [string, string][] = [];
        const { engine, calls } = scriptedEngine();
        const res = await postChat(sessionId, undefined, engine, {
          permissions: new Set(["chat:write", "mcp:read", "mcp:invoke"]),
          body: { skill_mode: skillMode, pinned_skills: [] },
          loadEnforcedChatSkills: async (orgId, spaceId) => {
            loaded.push([orgId, spaceId]);
            return [HOUSE];
          },
        });
        expect(res.status).toBe(200);
        await collectUiChunks(res);

        // Keyed on the space the router entered, not on a header.
        expect(loaded).toEqual([[ctx.orgId, ctx.defaultSpaceId]]);
        const system = calls[0]!.system;
        expect(system).toContain("This space requires these skills in every conversation.");
        expect(system).toContain(
          '<skill id="@acme/house" version="2.0.0">\nAlways sign with the house motto.\n</skill>',
        );
        // The turn's token still reaches no skill: the content needed none, and
        // only the enforced lead names `read_skill` (no loading rule is taught).
        expect(system).not.toContain("LOAD IT BEFORE acting");
        expect(system.split("read_skill")).toHaveLength(2);
        expect(await tokenPermissions(calls[0]!)).toEqual(["chat:write", "mcp:invoke", "mcp:read"]);

        await waitForAssistantPersist(sessionId);
      }
    });

    it("keeps them when the caller-context read fails", async () => {
      const sessionId = mintSessionId();
      const { engine, calls } = scriptedEngine();
      const res = await postChat(sessionId, undefined, engine, {
        permissions: new Set(["chat:write", "mcp:read", "mcp:invoke"]),
        context: () => new Response(null, { status: 500 }),
        loadEnforcedChatSkills: async () => [HOUSE],
      });
      expect(res.status).toBe(200);
      await collectUiChunks(res);

      const system = calls[0]!.system;
      expect(system).not.toContain(CONTEXT_ORG_MARKER);
      expect(system).toContain('<skill id="@acme/house" version="2.0.0">');

      await waitForAssistantPersist(sessionId);
    });
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
    expect(input.system).toContain(buildSystemPrompt(turnCapabilities(() => false)).slice(0, 64));
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
   * The preamble overlap.
   *
   * The caller-context read (`/api/me/context`) depends on the space id and the
   * caller's headers only — never on the chosen model or the admission gate —
   * so the handler starts it the moment the space id is known, under the model
   * list. Pinned here: the context request is dispatched BEFORE the model list
   * has answered. With the reads back in series (context after models → pick →
   * resolve → gate) it can only start after `models:end`, and this fails.
   */
  it("dispatches the caller-context read before the model list has answered", async () => {
    const events: string[] = [];
    const base = scriptedDispatch();
    const dispatch = async (req: Request): Promise<Response> => {
      const path = new URL(req.url).pathname;
      if (path === "/api/models") {
        events.push("models:start");
        // Long enough that a serial context read is unambiguously later.
        await new Promise((r) => setTimeout(r, 50));
        events.push("models:end");
      } else if (path === "/api/me/context") {
        events.push("context:start");
      }
      return base(req);
    };

    const sessionId = mintSessionId();
    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine, {
      dispatch,
      // Scripted so the ordering is observable in isolation — the platform's
      // own resolution needs the boot-time system-model registry, which is
      // beside the point here.
      resolveChatModel: async () => ({ subscription: false }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const contextStart = events.indexOf("context:start");
    const modelsEnd = events.indexOf("models:end");
    expect(contextStart).toBeGreaterThanOrEqual(0);
    expect(modelsEnd).toBeGreaterThanOrEqual(0);
    expect(contextStart).toBeLessThan(modelsEnd);
    // The overlapped block still reached the prompt — it was joined, not lost.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain(CONTEXT_ORG_MARKER);

    await waitForAssistantPersist(sessionId);
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
            packageId: "@acme/report",
            status: "failed",
            runNumber: 41,
            started_at: new Date().toISOString(),
            error: "provider timed out",
          },
          { packageId: "@acme/triage", status: "success", runNumber: 42 },
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

  describe("the composer's agent-authoring switch", () => {
    /** The one argument a model needs to compose an inline agent, whatever the prose. */
    const INLINE_MARKER = 'kind:"inline"';
    const REDUCED_MARKER = "Do not create or modify an agent in this turn";
    /** The tool a turn is taught only when it may launch AND read the run back. */
    const RUN_MARKER = "run_and_wait";
    /** The one authoring rule that needs no run — taught on `agents:write` ∧ invoke. */
    const SKILLS_MARKER = "Skills are not run on their own";
    /** A skill the context block lists only to a turn that reads skills (`readsSkills`). */
    const SKILL_ID = "@acme/research";

    // A builder as the platform grants it: running needs the MCP pair
    // (`mcp:read`, the transport floor, ∧ `mcp:invoke` — no tool call reaches a
    // route without them) plus launch plus run-read.
    const BUILDER = new Set([
      "agents:read",
      "agents:run",
      "agents:write",
      "mcp:invoke",
      "mcp:read",
      "runs:read",
    ]);

    async function turn(
      permissions: Set<string>,
      agentAuthoring?: boolean,
      context?: () => Response,
    ) {
      const { engine, calls } = scriptedEngine();
      const res = await postChat(mintSessionId(), undefined, engine, {
        permissions,
        ...(agentAuthoring === undefined ? {} : { agentAuthoring }),
        ...(context === undefined ? {} : { context }),
      });
      expect(res.status).toBe(200);
      await collectUiChunks(res);
      const input = calls[0]!;
      return { token: await tokenPermissions(input), system: input.system };
    }

    it("keeps `agents:write` and teaches inline composition when on", async () => {
      const { token, system } = await turn(BUILDER, true);
      expect(token).toEqual([
        "agents:read",
        "agents:run",
        "agents:write",
        "mcp:invoke",
        "mcp:read",
        "runs:read",
      ]);
      expect(system).toContain(INLINE_MARKER);
      expect(system).not.toContain(REDUCED_MARKER);
    });

    it("drops only `agents:write` from the token and the inline teaching when off", async () => {
      const { token, system } = await turn(BUILDER, false);
      expect(token).toEqual(["agents:read", "agents:run", "mcp:invoke", "mcp:read", "runs:read"]);
      expect(system).not.toContain(INLINE_MARKER);
      expect(system).toContain(REDUCED_MARKER);
      // Running an EXISTING agent survives the switch — it needs no authoring.
      expect(system).toContain(RUN_MARKER);
    });

    it("is on when the body carries no flag", async () => {
      const { token, system } = await turn(BUILDER);
      expect(token).toContain("agents:write");
      expect(system).toContain(INLINE_MARKER);
    });

    it("never grants `agents:write` to a caller who lacks it", async () => {
      const { token, system } = await turn(new Set(["agents:run"]), true);
      expect(token).toEqual(["agents:run"]);
      expect(system).not.toContain(INLINE_MARKER);
    });

    it("teaches inline composition only with `agents:run` as well", async () => {
      const { token, system } = await turn(new Set(["agents:write"]), true);
      expect(token).toEqual(["agents:write"]);
      expect(system).not.toContain(INLINE_MARKER);
      // It may still create agents: nothing tells it otherwise.
      expect(system).not.toContain(REDUCED_MARKER);
    });

    it("teaches no run to a launcher that could not read the run back", async () => {
      // `agents:run` alone launches a container the turn can never poll — the
      // same conjunction `run_and_wait` is declared on, so the tool is absent.
      const { system } = await turn(new Set(["mcp:read", "mcp:invoke", "agents:run"]), true);
      expect(system).not.toContain(RUN_MARKER);
      expect(system).not.toContain(INLINE_MARKER);
    });

    it("teaches the run once launch and run-read are both held", async () => {
      const { system } = await turn(
        new Set(["mcp:read", "mcp:invoke", "agents:run", "runs:read-all"]),
        true,
      );
      expect(system).toContain(RUN_MARKER);
      // `runs:read-all` is a superset of `runs:read`, never a literal test.
      expect(system).toContain('kind:"agent"');
    });

    it("teaches no run without `mcp:read` — the MCP transport admits nobody", async () => {
      // `mcp:invoke` alone is not enough: the endpoint the chat's own MCP client
      // talks to is guarded by `requireModulePermission("mcp", "read")`, so the
      // turn could never list the tool it was taught. Same discriminator as the
      // `mcp:invoke` case below — no `agents:write`, so REDUCED_MARKER would
      // render if the run branch were still there.
      const { system } = await turn(new Set(["mcp:invoke", "agents:run", "runs:read"]), true);
      expect(system).not.toContain(RUN_MARKER);
      expect(system).not.toContain(INLINE_MARKER);
      expect(system).not.toContain(REDUCED_MARKER);
    });

    it("teaches no run without `mcp:invoke` — no tool call reaches a route", async () => {
      // No `agents:write`, so the reduced branch's "do not create an agent"
      // line WOULD render if the run branch were still there: its absence
      // discriminates. (Holding `agents:write` makes that marker impossible
      // whatever the run flag, which is why the set below omits it.)
      const { system } = await turn(new Set(["mcp:read", "agents:run", "runs:read"]), true);
      expect(system).not.toContain(RUN_MARKER);
      expect(system).not.toContain(INLINE_MARKER);
      // Absent, not contradicted: the branch is gone, not answered with a refusal.
      expect(system).not.toContain(REDUCED_MARKER);
    });

    it("teaches no authoring without `mcp:invoke` — `createAgent` dispatches through it", async () => {
      // `agents:write` without `mcp:invoke` is a grant the turn cannot dispatch.
      // Skills are the counterpoint: `read_skill` needs no dispatch, so they stay.
      const withSkill = () =>
        Response.json({
          user: { name: "Chat Tester", email: "chat-tester@test.com" },
          org: { role: "owner", name: CONTEXT_ORG_MARKER, slug: "chat-handler-test" },
          connections: [],
          agents: [],
          skills: [{ packageId: SKILL_ID, display_name: "Research", version: "1.2.0" }],
          recent_runs: [],
        });
      const { system } = await turn(
        new Set(["mcp:read", "agents:write", "skills:read"]),
        true,
        withSkill,
      );
      expect(system).not.toContain(SKILLS_MARKER);
      expect(system).toContain(SKILL_ID);
      expect(system).toContain("call `read_skill` with its `id`");
      // Control: the same set plus `mcp:invoke` IS taught authoring.
      const { system: invoking } = await turn(
        new Set(["mcp:read", "mcp:invoke", "agents:write", "skills:read"]),
        true,
        withSkill,
      );
      expect(invoking).toContain(SKILLS_MARKER);
      expect(invoking).toContain(SKILL_ID);
    });

    it("keeps the run-history rule for a turn that reads runs but cannot launch", async () => {
      // Reading runs is its own conjunction (`mcp:invoke` ∧ run-read) and does
      // not depend on `agents:run` — `listRuns` stays, `run_and_wait` does not.
      const { system } = await turn(new Set(["mcp:read", "mcp:invoke", "runs:read"]), true);
      expect(system).toContain("listRuns");
      expect(system).toContain("Never quote run metrics");
      expect(system).not.toContain(RUN_MARKER);
      // A turn that cannot even read them is told neither.
      const { system: blind } = await turn(new Set(["agents:read"]), true);
      expect(blind).not.toContain("listRuns");
      expect(blind).not.toContain("Never quote run metrics");
    });
  });
});
