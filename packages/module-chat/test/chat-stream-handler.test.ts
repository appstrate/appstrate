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

import { fullAgent, meBody } from "./me-context-body.ts";
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Hono } from "hono";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  chatMessages,
  chatSessions,
  chatSessionSpaces,
  files,
  uploads,
  type ChatSkillStatusEntry,
} from "@appstrate/db/schema";
import { uploadStream } from "@appstrate/db/storage";
import { createUpload } from "../../../apps/api/src/services/uploads.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../../apps/api/test/helpers/auth.ts";
import { seedRun, seedSpace } from "../../../apps/api/test/helpers/seed.ts";
import { createUIMessageStreamResponse, type UIMessage, type UIMessageChunk } from "ai";
import {
  CHAT_MESSAGE_MAX_BYTES,
  handleChatStream,
  type ChatEngine,
  type ChatEnv,
} from "../src/chat-stream.ts";
import { drainTurns } from "../src/inflight.ts";
import { mintSessionId } from "../src/session-id.ts";
import { logger } from "../src/logger.ts";
import { acquirePiChatSlot, releaseOnClose } from "../src/pi-chat/concurrency.ts";
import type { PiChatInput } from "../src/pi-chat/engine.ts";
import {
  INJECTED_SKILLS_AUTH_EXTRA,
  type ChatAttachmentRequest,
  type ChatUsageRecord,
} from "@appstrate/core/chat-contract";
import type { PrincipalKind, ReachableSpaceGrant } from "@appstrate/core/module";
import { buildChatPlatformDeps, type ChatPlatformDeps } from "../src/platform-services.ts";
import { buildModuleInitContext } from "../../../apps/api/src/lib/modules/registry.ts";
import { errorHandler } from "../../../apps/api/src/middleware/error-handler.ts";
import { initSystemModelProviderKeys } from "../../../apps/api/src/services/model-registry.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { turnCapabilities } from "../src/capabilities.ts";
import { chatLoopbackStrategy } from "../src/loopback-auth.ts";
import { platformMcpSurfaceKey } from "../src/pi-chat/mcp-surface-cache.ts";
import { _resetChatEnvForTests } from "../src/env.ts";
import { ensureSession, persistAssistantMessage, persistUserMessage } from "../src/persistence.ts";
import {
  createFileFromStream,
  readChatAttachment,
  resolveChatAttachment,
} from "../../../apps/api/src/services/files.ts";
import { buildStructuredPiTurn } from "../src/pi-chat/structured-session.ts";
import { loadAttachmentImages } from "../src/pi-chat/attachment-inputs.ts";
import { reachableSpace } from "./reachable-space.ts";
import { CHAT_SKILLS_CONTENT_BUDGET_CHARS } from "../src/skills.ts";
import { buildPlatformMcpTools } from "../src/pi-chat/mcp-tools.ts";
import { PiChatUiStreamMapper } from "../src/pi-chat/ui-stream-mapper.ts";
import { spaceIdRefusal } from "@appstrate/core/mcp-spaces";
import { fakePlatformMcp, fakeSkillUri, type FakeSkill } from "./fake-platform-mcp.ts";

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

// A distinctive marker in the request context's organization name, so we can prove the
// caller-context block was rendered into the system prompt.
const CONTEXT_ORG_MARKER = "ChatHandlerTestOrg";

const MODEL_PRESET_ID = "model_chat_handler_test";
const TEST_REQUEST_ID = "req_chat_handler_test";

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

/** Build the scripted in-memory dispatch. Nothing leaves this process. */
function scriptedDispatch(
  apiShape?: string,
  listedSkill?: FakeSkill,
): (req: Request) => Promise<Response> {
  const models = async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (path === "/api/models") return modelsResponse(apiShape);
    return new Response("unexpected dispatch: " + path, { status: 404 });
  };
  return listedSkill ? fakePlatformMcp({ skills: [listedSkill] }, models) : models;
}

/**
 * A scripted engine: records what the handler handed it, then streams the same
 * chunk sequence the Pi mapper emits for a plain text answer, with the route's
 * `leadingChunks` right after `start` as `runPiChat` writes them. The concurrency
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
      ...(input.leadingChunks ?? []),
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

/** The injected-skills claim the turn's MCP bearer resolves to. */
async function tokenInjectedSkills(input: PiChatInput): Promise<unknown> {
  const resolved = await chatLoopbackStrategy.authenticate({
    headers: new Headers({ authorization: input.platformMcp!.headers!.Authorization! }),
  } as never);
  return resolved!.extra?.[INJECTED_SKILLS_AUTH_EXTRA];
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

/** The spaces the turn's bearer allowlists, as the loopback strategy resolves them. */
async function tokenSpaceIds(input: PiChatInput): Promise<readonly string[] | undefined> {
  const authorization = input.platformMcp?.headers?.Authorization;
  const resolved = await chatLoopbackStrategy.authenticate({
    headers: new Headers({ authorization: authorization as string }),
  } as never);
  expect(resolved).not.toBeNull();
  return resolved!.spaceIds;
}

// A turn persists in a background task that outlives its response, and the registry of those
// tasks is a process-wide singleton: a test that returns while one is still settling hands it
// to whichever file runs next (`inflight.test.ts` then counts a turn it never tracked).
afterEach(async () => {
  await drainTurns(5_000);
});

describe("handleChatStream", () => {
  let ctx: TestContext;
  /** What `app.onError` saw, so a thrown invariant can be asserted on its message. */
  let handlerError: Error | null = null;

  beforeEach(async () => {
    await truncateAll();
    handlerError = null;
    ctx = await createTestContext({ orgSlug: "chat-handler-org" });
  });

  /** The test context's one space, holding `permissions` on top of what makes it an acting space. */
  function defaultReach(permissions: ReadonlySet<string> = new Set()): ReachableSpaceGrant {
    return reachableSpace({
      id: ctx.defaultSpaceId,
      name: "Default",
      role: "owner",
      permissions: [...new Set(["chat:read", "chat:write", "mcp:read", ...permissions])],
    });
  }

  /** A `Hono<ChatEnv>` app mirroring what the platform auth pipeline sets. */
  function buildApp(
    deps: ReturnType<typeof buildChatPlatformDeps>,
    engine?: ChatEngine,
    reachable: ReachableSpaceGrant[],
    principalKind: PrincipalKind = "user",
    orgHalf: ReadonlySet<string> = new Set(),
  ) {
    const app = new Hono<ChatEnv>();
    // Mirror production's RFC 9457 error boundary so invalid client input is
    // asserted at the HTTP contract, not as an uncaught handler exception. The
    // boundary renders a non-`ApiError` as a bare 500, so keep the error itself.
    app.onError((error, context) => {
      handlerError = error;
      return errorHandler(error, context as never);
    });
    app.post("/api/orgs/:orgId/chat", (c) => {
      c.set("requestId", TEST_REQUEST_ID);
      c.set("orgId", ctx.orgId);
      c.set("user", ctx.user);
      // What the router's middleware writes on every chat route in production: the spaces the
      // caller reaches.
      c.set("reachable", reachable);
      c.set("reachableOrgHalf", orgHalf);
      c.set("principalKind", principalKind);
      c.set("orgRole", "owner");
      c.set("orgName", CONTEXT_ORG_MARKER);
      c.set("orgSlug", ctx.org.slug);
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
      /** Stand in for the platform's usage writer. */
      recordChatUsage?: ChatPlatformDeps["recordChatUsage"];
      /** The one skill the scripted platform MCP server lists. */
      listedSkill?: FakeSkill;
      /** Replace the whole scripted dispatch (to observe request timing). */
      dispatch?: (req: Request) => Promise<Response>;
      /** Stand in for the platform's composer-attachment resolution. */
      resolveChatAttachment?: ChatPlatformDeps["resolveChatAttachment"];
      /** The caller's grants in the test context's one space, besides the ones that make it an acting space. */
      permissions?: Set<string>;
      /** Replace the single user message (to carry a composer attachment). */
      parts?: unknown[];
      /** The new message's id; an empty one makes an unpersisted turn. */
      messageId?: string;
      /** The kind the auth pipeline resolved; production reaches here as `user` only. */
      principalKind?: PrincipalKind;
      /** The composer's package-authoring switch for this turn; omitted = on. */
      packageAuthoring?: boolean;
      /** The spaces the caller reaches; omitted = the test context's default space, with `permissions`. */
      reachable?: ReachableSpaceGrant[];
      /** The org-level half of the caller's grants (`ReachedSpaces.orgPermissions`); omitted = none. */
      orgHalf?: ReadonlySet<string>;
      /** Earlier turns replayed ahead of the new user message. */
      history?: unknown[];
      /** Extra body fields, e.g. a new conversation's `pins` / `skill_discovery`. */
      body?: Record<string, unknown>;
      /** The admission gate; omitted = the platform's. */
      checkUsageAllowed?: ChatPlatformDeps["checkUsageAllowed"];
    },
  ): Promise<Response> {
    // Real platform deps (the same context `init()` gets), with dispatch
    // overridden by the scripted one so no request leaves this process.
    const initCtx = buildModuleInitContext();
    const deps = {
      ...buildChatPlatformDeps(initCtx),
      dispatch:
        overrides?.dispatch ?? scriptedDispatch(overrides?.apiShape, overrides?.listedSkill),
      ...(overrides?.resolveChatModel ? { resolveChatModel: overrides.resolveChatModel } : {}),
      ...(overrides?.recordChatUsage ? { recordChatUsage: overrides.recordChatUsage } : {}),
      ...(overrides?.checkUsageAllowed ? { checkUsageAllowed: overrides.checkUsageAllowed } : {}),
      ...(overrides?.resolveChatAttachment
        ? { resolveChatAttachment: overrides.resolveChatAttachment }
        : {}),
    };
    const app = buildApp(
      deps,
      engine,
      overrides?.reachable ?? [defaultReach(overrides?.permissions)],
      overrides?.principalKind,
      overrides?.orgHalf,
    );
    const res = await app.request(`/api/orgs/${ctx.orgId}/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-org-id": ctx.orgId,
      },
      body: JSON.stringify({
        id: sessionId,
        messages: [
          ...(overrides?.history ?? []),
          {
            id: overrides?.messageId ?? "u1",
            role: "user",
            parts: overrides?.parts ?? [{ type: "text", text: "dis bonjour" }],
          },
        ],
        ...(generation ? { generation } : {}),
        ...(overrides?.packageAuthoring === undefined
          ? {}
          : { package_authoring: overrides.packageAuthoring }),
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
        return {
          uri: request.uri,
          name: "r.txt",
          mime: "text/plain",
          size: 12,
          spaceId: request.spaces[0]!.id,
        };
      },
    });

    expect(res.status).toBe(200);
    await collectUiChunks(res);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.spaces.map((space) => space.id)).toEqual([ctx.defaultSpaceId]);
    expect([...requests[0]!.spaces[0]!.permissions].sort()).toEqual([
      "chat:read",
      "chat:write",
      "mcp:read",
      "runs:read-all",
    ]);
    await waitForAssistantPersist(sessionId);
  });

  it("tells the browser which file each sent upload became, without persisting it", async () => {
    // The browser's copy of the user message keeps its optimistic `upload://`
    // parts; only this chunk lets its chips open the file before a reload.
    const sessionId = mintSessionId();
    const { engine } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine, {
      parts: [
        { type: "text", text: "lis ceci" },
        { type: "file", url: "upload://upl_sent", mediaType: "text/plain", filename: "a.txt" },
        // Already stored (picked from the gallery): nothing to tell.
        {
          type: "file",
          url: "appfile://file_picked12",
          mediaType: "text/plain",
          filename: "b.txt",
        },
      ],
      resolveChatAttachment: async (request) => ({
        uri: request.uri === "upload://upl_sent" ? "appfile://file_sent12345" : request.uri,
        name: "a.txt",
        mime: "text/plain",
        size: 3,
        spaceId: ctx.defaultSpaceId,
      }),
    });

    expect(res.status).toBe(200);
    const chunks = await collectUiChunks(res);
    expect(chunks.filter((chunk) => chunk.type === "data-upload-resolutions")).toEqual([
      {
        type: "data-upload-resolutions",
        data: [
          { uri: "upload://upl_sent", file: { id: "file_sent12345", spaceId: ctx.defaultSpaceId } },
        ],
        transient: true,
      },
    ]);

    await waitForAssistantPersist(sessionId);
    const rows = await db
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId));
    const assistant = rows
      .map((row) => row.content as UIMessage)
      .find((message) => message.role === "assistant");
    expect(assistant?.parts.map((part) => part.type)).toEqual(["text"]);
  });

  it("writes no resolutions for a turn that sent no upload", async () => {
    const sessionId = mintSessionId();
    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine);
    await collectUiChunks(res);
    expect(calls[0]?.leadingChunks).toBeUndefined();
    await waitForAssistantPersist(sessionId);
  });

  describe("a turn its claim refuses", () => {
    const attachment = {
      type: "file",
      url: "upload://upl_refused",
      mediaType: "text/plain",
      filename: "r.txt",
    };
    async function refusedTurn(sessionId: string, beforeClaim: () => Promise<void>) {
      const requests: ChatAttachmentRequest[] = [];
      const { engine, calls } = scriptedEngine();
      const res = await postChat(sessionId, undefined, engine, {
        parts: [{ type: "text", text: "lis ceci" }, attachment],
        // Runs after the turn read the conversation, before it claims it.
        resolveChatModel: async () => {
          await beforeClaim();
          return { subscription: false };
        },
        resolveChatAttachment: async (request) => {
          requests.push(request);
          await request.beforeResolve?.(ctx.defaultSpaceId);
          return {
            uri: "appfile://file_refused0",
            name: "r.txt",
            mime: "text/plain",
            size: 1,
            spaceId: ctx.defaultSpaceId,
          };
        },
      });
      return { res, requests, calls };
    }
    const rowOf = async (sessionId: string) =>
      (await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)))[0]!;

    it("on a scope change materializes nothing, records no space and writes no message", async () => {
      const sessionId = mintSessionId();
      await ensureSession(
        sessionId,
        ctx.orgId,
        ctx.user.id,
        [ctx.defaultSpaceId],
        undefined,
        () => ({
          spaceId: ctx.defaultSpaceId,
          restricted: false,
        }),
      );
      const { res, requests, calls } = await refusedTurn(sessionId, async () => {
        await db
          .update(chatSessions)
          .set({ restricted: true })
          .where(eq(chatSessions.id, sessionId));
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("chat_turn_scope_changed");
      expect(requests).toEqual([]);
      expect(calls).toEqual([]);
      expect(await db.select().from(chatSessionSpaces)).toEqual([]);
      expect(await db.select().from(chatMessages)).toEqual([]);
      expect((await rowOf(sessionId)).activeStreamId).toBeNull();
    });

    it("while another turn is live answers chat_turn_in_flight and leaves that turn's marker", async () => {
      const sessionId = mintSessionId();
      await ensureSession(sessionId, ctx.orgId, ctx.user.id, [ctx.defaultSpaceId]);
      const { res, requests, calls } = await refusedTurn(sessionId, async () => {
        await db
          .update(chatSessions)
          .set({ activeStreamId: "strm_live" })
          .where(eq(chatSessions.id, sessionId));
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("chat_turn_in_flight");
      expect(requests).toEqual([]);
      expect(calls).toEqual([]);
      expect(await db.select().from(chatMessages)).toEqual([]);
      expect((await rowOf(sessionId)).activeStreamId).toBe("strm_live");
    });
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

  it.each(["read", "read_resource", "any_tool_name"])(
    "keeps an old tab's %s result out of the next model request after the grant is revoked",
    async (toolName) => {
      const scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
      const run = await seedRun({ ...scope, userId: ctx.user.id });
      const pdf = new Blob(["%PDF-1.4\nSynthetic contract version 3\n%%EOF"]);
      const { row } = await createFileFromStream(
        scope,
        run.id,
        { userId: ctx.user.id, endUserId: null },
        null,
        {
          name: "contract.pdf",
          mime: "application/pdf",
          body: pdf.stream(),
        },
      );
      const uri = `appfile://${row.id}`;
      const read = {
        kind: "pdf",
        maxBytes: pdf.size,
        signal: new AbortController().signal,
      } as const;
      const previousRead = await readChatAttachment({
        orgId: ctx.orgId,
        userId: ctx.user.id,
        chatSessionId: null,
        spaces: [{ id: scope.spaceId, permissions: new Set(["files:read"]) }],
        personalSpaceId: null,
        beforeResolve: async () => {},
        uri,
        ...read,
      });
      expect(previousRead?.bytes).toEqual(new Uint8Array(await pdf.arrayBuffer()));
      const blob = Buffer.from(previousRead!.bytes).toString("base64");
      const question: UIMessage = {
        id: "u0",
        role: "user",
        parts: [{ type: "text", text: "Lis le contrat." }],
      };
      const answer = (result: string): UIMessage => ({
        id: "a0",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "read_0",
            toolName,
            state: "output-available",
            input: { uri },
            output: { content: [{ type: "text", text: result }] },
          },
        ],
      });
      // The stored row was migrated while the tab retained the result of its authorized read.
      const sessionId = mintSessionId();
      await ensureSession(sessionId, ctx.orgId, ctx.user.id, [scope.spaceId]);
      await persistUserMessage(sessionId, question);
      await persistAssistantMessage(
        sessionId,
        answer(
          JSON.stringify({
            uri,
            mimeType: row.mime,
            size: row.size,
            note: "File content omitted: read in an earlier version of the chat.",
          }),
        ),
        question.id,
      );

      const { engine, calls } = scriptedEngine();
      const resource = { uri, mimeType: row.mime, blob };
      const oldResult = toolName === "read" ? { type: "resource", resource } : resource;
      const res = await postChat(sessionId, undefined, engine, {
        permissions: new Set(),
        history: [question, answer(JSON.stringify(oldResult))],
      });
      expect(res.status).toBe(200);
      await collectUiChunks(res);
      const input = calls[0]!;
      expect(await input.readAttachment!(uri, read)).toBeNull();
      const { api, provider, id } = input.modelBinding.model;
      const turn = buildStructuredPiTurn(
        input.messages,
        { api, provider, model: id },
        { estimateTokens: () => 1, baseTokens: 0, fileDelivery: { image: false, pdf: false } },
      );
      const result = turn.history.find((message) => message.role === "toolResult");
      expect(JSON.stringify(result?.content)).toContain(uri);
      expect(JSON.stringify(turn.history)).not.toContain(blob);
      await waitForAssistantPersist(sessionId);
      const rows = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, sessionId));
      expect(rows).toHaveLength(4);
      expect(JSON.stringify(rows)).not.toContain(blob);
    },
  );

  it("takes an earlier turn's files from its stored row, never from the history the browser sends", async () => {
    const scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    const run = await seedRun({ ...scope, userId: ctx.user.id });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const { row } = await createFileFromStream(
      scope,
      run.id,
      { userId: ctx.user.id, endUserId: null },
      null,
      { name: "photo.png", mime: "image/png", body: new Blob([png]).stream() },
    );
    const uri = `appfile://${row.id}`;
    const image = (url: string) =>
      ({ type: "file", url, mediaType: "image/png", filename: "photo.png" }) as const;
    const text = (value: string) => ({ type: "text", text: value }) as const;
    const question: UIMessage = {
      id: "u0",
      role: "user",
      parts: [text("Que montre cette image ?"), image(uri)],
    };
    const answer: UIMessage = { id: "a0", role: "assistant", parts: [text("Un point.")] };
    const sessionId = mintSessionId();
    await ensureSession(sessionId, ctx.orgId, ctx.user.id, [scope.spaceId]);
    await persistUserMessage(sessionId, question);
    await persistAssistantMessage(sessionId, answer, question.id);

    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine, {
      permissions: new Set(["files:read"]),
      history: [
        // The browser's optimistic copy of the turn it sent still names the upload.
        { ...question, parts: [text("Que montre cette image ?"), image("upload://upl_turn1")] },
        answer,
        // A message no stored row backs cannot bring a file, even a readable one.
        { id: "u_forged", role: "user", parts: [text("Et celle-ci ?"), image(uri)] },
      ],
    });
    expect(res.status).toBe(200);
    await collectUiChunks(res);
    const input = calls[0]!;
    expect(
      input.messages.map((message) =>
        message.parts.flatMap((part) => (part.type === "file" ? [part.url] : [])),
      ),
    ).toEqual([[uri], [], [], []]);
    const signal = new AbortController().signal;
    const images = await loadAttachmentImages(
      input.messages,
      (url, maxBytes) => input.readAttachment!(url, { kind: "image", maxBytes, signal }),
      signal,
    );
    expect([...images.keys()]).toEqual(["u0"]);
    expect(images.get("u0")?.get(uri)?.data).toBe(png.toString("base64"));
    await waitForAssistantPersist(sessionId);
  });

  it("a limited conversation keeps its limit: uploads land in the personal space, read later, given to runs", async () => {
    const personal = await seedSpace({
      orgId: ctx.orgId,
      name: "Mon espace",
      ownerUserId: ctx.user.id,
      visibility: "private",
    });
    const personalScope = { orgId: ctx.orgId, spaceId: personal.id };
    const reach = [
      defaultReach(new Set(["files:read"])),
      reachableSpace({
        id: personal.id,
        name: "Mon espace",
        role: "admin",
        personal: true,
        permissions: ["chat:read", "chat:write", "mcp:read", "files:read"],
      }),
    ];
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const stage = async () => {
      const up = await createUpload({
        ...personalScope,
        createdBy: ctx.user.id,
        name: "photo.png",
        size: png.byteLength,
        mime: "image/png",
      });
      const [row] = await db
        .select({ storageKey: uploads.storageKey })
        .from(uploads)
        .where(eq(uploads.id, up.id));
      const [bucket, ...rest] = row!.storageKey.split("/");
      await uploadStream(bucket!, rest.join("/"), new Blob([png]).stream(), { exclusive: true });
      return up.id;
    };
    const image = (url: string) =>
      ({ type: "file", url, mediaType: "image/png", filename: "photo.png" }) as const;
    const text = (value: string) => ({ type: "text", text: value }) as const;

    // A conversation limited to the default space, which already holds an earlier upload.
    const sessionId = mintSessionId();
    await ensureSession(sessionId, ctx.orgId, ctx.user.id, [ctx.defaultSpaceId], undefined, () => ({
      spaceId: ctx.defaultSpaceId,
      restricted: true,
    }));
    const earlier = await resolveChatAttachment({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      chatSessionId: sessionId,
      uri: `upload://${await stage()}`,
      spaces: [],
      personalSpaceId: personal.id,
      beforeResolve: async () => {},
    });
    const question: UIMessage = {
      id: "u0",
      role: "user",
      parts: [text("Et ça ?"), image(earlier.uri)],
    };
    const answer: UIMessage = { id: "a0", role: "assistant", parts: [text("Un point.")] };
    await persistUserMessage(sessionId, question);
    await persistAssistantMessage(sessionId, answer, question.id);

    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine, {
      reachable: reach,
      history: [question, answer],
      parts: [text("Et celle-ci ?"), image(`upload://${await stage()}`)],
    });
    expect(res.status).toBe(200);
    await collectUiChunks(res);
    await waitForAssistantPersist(sessionId);
    const input = calls[0]!;

    // Both uploads live in the personal space, held by the conversation, which stays limited.
    const held = await db
      .select({ id: files.id, spaceId: files.spaceId })
      .from(files)
      .where(eq(files.chatSessionId, sessionId));
    expect(held.map((file) => file.spaceId)).toEqual([personal.id, personal.id]);
    expect(
      await db.select().from(chatSessionSpaces).where(eq(chatSessionSpaces.sessionId, sessionId)),
    ).toEqual([]);
    const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
    expect(row).toMatchObject({ spaceId: ctx.defaultSpaceId, restricted: true });
    expect(await tokenSpaceIds(input)).toEqual([ctx.defaultSpaceId]);

    // The turn reads both, the earlier turn's included, though the personal space is not its.
    const signal = new AbortController().signal;
    const images = await loadAttachmentImages(
      input.messages,
      (url, maxBytes) => input.readAttachment!(url, { kind: "image", maxBytes, signal }),
      signal,
    );
    expect([...images.keys()].sort()).toEqual(["u0", "u1"]);

    // Its bearer names the conversation, so a run it launches may consume those files.
    const resolved = await chatLoopbackStrategy.authenticate({
      headers: new Headers({ authorization: input.platformMcp!.headers!.Authorization as string }),
    } as never);
    expect(resolved?.extra?.chatSessionId).toBe(sessionId);

    // An unpersisted turn naming the same conversation is not it: its reads get no widening.
    const { engine: ephemeralEngine, calls: ephemeralCalls } = scriptedEngine();
    // The personal space reads files but takes no chat there: only the conversation reaches it.
    const ephemeral = await postChat(sessionId, undefined, ephemeralEngine, {
      reachable: [
        reach[0]!,
        reachableSpace({ id: personal.id, personal: true, permissions: ["files:read"] }),
      ],
      messageId: "",
      parts: [text("Et ça ?"), image(`upload://${await stage()}`)],
    });
    expect(ephemeral.status).toBe(200);
    await collectUiChunks(ephemeral);
    expect(
      await ephemeralCalls[0]!.readAttachment!(earlier.uri, {
        kind: "image",
        maxBytes: 4096,
        signal,
      }),
    ).toBeNull();
    // Nor does it exempt the conversation's file from its space's checks, nor hold an upload.
    expect(await ephemeralCalls[0]!.platformMcp!.organization.fileSpace(earlier.uri)).toBe(
      personal.id,
    );
    const heldNow = await db
      .select({ id: files.id })
      .from(files)
      .where(eq(files.chatSessionId, sessionId));
    expect(heldNow).toHaveLength(2);

    // A file the conversation holds names no space; another file of the same space names it.
    expect(await input.platformMcp!.organization.fileSpace(earlier.uri)).toBeUndefined();
    const run = await seedRun({ ...personalScope, userId: ctx.user.id });
    const { row: output } = await createFileFromStream(
      personalScope,
      run.id,
      { userId: ctx.user.id, endUserId: null },
      null,
      { name: "out.txt", mime: "text/plain", body: new Blob(["x"]).stream() },
    );
    expect(await input.platformMcp!.organization.fileSpace(`appfile://${output.id}`)).toBe(
      personal.id,
    );
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

  it("names the reason of a turn refused for lack of a usable model, in one info line", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      const { engine, calls } = scriptedEngine();
      const res = await postChat(mintSessionId(), undefined, engine, {
        dispatch: async (req) =>
          new URL(req.url).pathname === "/api/models"
            ? Response.json({ object: "list", hasMore: false, data: [] })
            : scriptedDispatch()(req),
      });

      expect(res.status).toBe(400);
      expect(calls).toEqual([]);
      expect(
        info.mock.calls.filter(([msg]) => msg === "chat turn refused: no usable model"),
      ).toEqual([
        [
          "chat turn refused: no usable model",
          {
            orgId: ctx.orgId,
            requested: null,
            reason: "No enabled model is configured (Settings → Models).",
          },
        ],
      ]);
    } finally {
      info.mockRestore();
    }
  });

  it("logs the raw error behind a marker the stream's onError produced", async () => {
    // An exception escaping the engine's `execute` reaches the client as the
    // same marker a model error does, and the drain ignores that marker.
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const { engine } = scriptedEngine();
      let marker: string | undefined;
      const res = await postChat(mintSessionId(), undefined, (input) => {
        marker = input.onError(new Error("ESCAPED_EXECUTE_SENTINEL"));
        return engine(input);
      });
      await res.text();

      expect(marker).toStartWith("appstrate:chat-turn-error:");
      expect(marker).toEndWith(`:${TEST_REQUEST_ID}`);
      expect(error.mock.calls).toEqual([
        [
          "chat turn stream failed",
          { err: "Error: ESCAPED_EXECUTE_SENTINEL", requestId: TEST_REQUEST_ID },
        ],
      ]);
    } finally {
      error.mockRestore();
    }
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

  it("without a selection in the body, keeps the stored one: discovery off injects the pinned skill and withholds `skills:*`", async () => {
    // Persona, context block and token must agree within one turn; all three
    // are wired from the one session-row read, which only this test can prove.
    const sessionId = mintSessionId();
    const PIN = "@acme/pinned-skill";
    await db.insert(chatSessions).values({
      id: sessionId,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      title: null,
      skillDiscovery: false,
      pinnedSkills: [PIN],
    });

    // The pinned skill is listed by the platform MCP server; record which
    // contents are read and with which bearer, so the rendered block is a
    // function of what the handler read.
    const pinned = { space: ctx.defaultSpaceId, id: PIN, text: "Always answer in haiku." };
    const uri = fakeSkillUri(pinned);
    const read: string[] = [];
    const skillBearers: string[] = [];
    const dispatch = fakePlatformMcp(
      {
        skills: [pinned],
        onMethod: (method, params, req) => {
          skillBearers.push(req.headers.get("authorization") ?? "");
          if (method === "resources/read") read.push(params?.uri as string);
        },
      },
      scriptedDispatch(),
    );

    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine, {
      dispatch,
      // Every `skills:*` is withheld, not only `skills:read`: a write echoes the SKILL.md.
      // `chat:write` is on every turn token: `resources/read` honours the claim only with it.
      permissions: new Set([
        "chat:write",
        "mcp:read",
        "mcp:invoke",
        "skills:read",
        "skills:write",
        "skills:delete",
      ]),
    });
    expect(res.status).toBe(200);
    await collectUiChunks(res);

    expect(read).toEqual([uri]);
    // The listing connection carries the caller's permissions, not the turn's
    // narrowed set, and no claim.
    const listing = await chatLoopbackStrategy.authenticate({
      headers: new Headers({ authorization: skillBearers[0]! }),
    } as never);
    expect([...(listing!.permissions ?? [])]).toContain("skills:read");
    expect(listing!.extra?.[INJECTED_SKILLS_AUTH_EXTRA]).toBeUndefined();
    const input = calls[0]!;
    expect(input.system).toContain(
      `<skill id="${PIN}" uri="${uri}" version="1.0.0">\nAlways answer in haiku.\n</skill>`,
    );
    // Discovery off lists no skill: the listed entry is injected, never a catalogue line.
    expect(input.system).not.toContain(`- \`${PIN}\``);
    // No skill tool is taught, and the token cannot reach one.
    // The injected skill's files stay readable; no loading or listing is taught.
    expect(input.system).toContain("read a file it references with `read_resource`");
    expect(input.system).not.toContain("LOAD IT BEFORE acting");
    expect(input.system).not.toContain("listSkills");
    expect(input.system).toContain("Skill discovery is off for this conversation");
    expect(await tokenPermissions(input)).toEqual([
      "chat:read",
      "chat:write",
      "mcp:invoke",
      "mcp:read",
    ]);
    // The bearer names what was injected, so `resources/read` serves it without `skills:read`.
    expect(await tokenInjectedSkills(input)).toEqual({
      skills: { [PIN]: { definition: "published", version: "1.0.0", spaceId: ctx.defaultSpaceId } },
    });

    await waitForAssistantPersist(sessionId);
  });

  /** The skills the platform MCP server lists in the default space, each served as `text`. */
  function listedSkillsDispatch(
    skills: Array<{ id: string; text: string; listedText?: string }>,
    /** Runs on each `skills/list`: inside the turn's preamble, between its upsert and its claim. */
    onList?: () => Promise<void>,
  ): (req: Request) => Promise<Response> {
    return fakePlatformMcp(
      {
        skills: skills.map((skill) => ({ space: ctx.defaultSpaceId, ...skill })),
        onMethod: async (method) => {
          if (method === "skills/list") await onList?.();
        },
      },
      scriptedDispatch(),
    );
  }

  const SKILL_TURN_PERMISSIONS = new Set(["mcp:read", "mcp:invoke", "skills:read"]);

  async function sessionSkills(sessionId: string) {
    const [row] = await db
      .select({
        skillDiscovery: chatSessions.skillDiscovery,
        pinnedSkills: chatSessions.pinnedSkills,
        skillStatus: chatSessions.skillStatus,
      })
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId));
    return row;
  }

  async function seedSkillSession(
    sessionId: string,
    skills: { pinned: string[]; status?: Record<string, ChatSkillStatusEntry> },
  ) {
    await db.insert(chatSessions).values({
      id: sessionId,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      title: null,
      pinnedSkills: skills.pinned,
      skillStatus: skills.status ?? {},
    });
  }

  const UNAVAILABLE = { status: "unavailable", chars: null } as const;

  it("writes the body's pins and discovery on the row it creates, and runs the turn on them", async () => {
    const sessionId = mintSessionId();
    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine, {
      permissions: SKILL_TURN_PERMISSIONS,
      dispatch: listedSkillsDispatch([]),
      body: { skill_discovery: false, pins: ["@acme/z", "@acme/a", "@acme/z"] },
    });
    expect(res.status).toBe(200);
    await collectUiChunks(res);

    expect(await sessionSkills(sessionId)).toEqual({
      skillDiscovery: false,
      pinnedSkills: ["@acme/a", "@acme/z"],
      // Listed nowhere (both listings answered): the claim records each pin's verdict.
      skillStatus: { "@acme/a": UNAVAILABLE, "@acme/z": UNAVAILABLE },
    });
    expect(await tokenPermissions(calls[0]!)).toEqual([
      "chat:read",
      "chat:write",
      "mcp:invoke",
      "mcp:read",
    ]);

    await waitForAssistantPersist(sessionId);
  });

  it("ignores `pins` and `skill_discovery` for an existing conversation: the turn runs on the stored ones", async () => {
    const sessionId = mintSessionId();
    await seedSkillSession(sessionId, {
      pinned: ["@acme/a"],
      status: { "@acme/a": { status: "injected", chars: 3 } },
    });
    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine, {
      permissions: SKILL_TURN_PERMISSIONS,
      dispatch: listedSkillsDispatch([
        { id: "@acme/a", text: "Stored pin." },
        { id: "@acme/b", text: "Body pin." },
      ]),
      body: { pins: ["@acme/b"], skill_discovery: false },
    });
    expect(res.status).toBe(200);
    await collectUiChunks(res);
    expect(calls[0]!.system).toContain("Stored pin.");
    expect(calls[0]!.system).not.toContain("Body pin.");
    expect(await sessionSkills(sessionId)).toMatchObject({
      pinnedSkills: ["@acme/a"],
      skillDiscovery: true,
    });

    await waitForAssistantPersist(sessionId);
  });

  it("applies an ephemeral turn's skill settings to the defaults, writing no row", async () => {
    const sessionId = mintSessionId();
    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine, {
      permissions: SKILL_TURN_PERMISSIONS,
      messageId: "",
      dispatch: listedSkillsDispatch([{ id: "@acme/a", text: "Ephemeral pin." }]),
      body: { pins: ["@acme/a"], skill_discovery: false },
    });
    expect(res.status).toBe(200);
    await collectUiChunks(res);
    expect(calls[0]!.system).toContain("Ephemeral pin.");
    expect(calls[0]!.system).toContain("Skill discovery is off");
    expect(await sessionSkills(sessionId)).toBeUndefined();
  });

  it("records each pin's verdict and size at the claim: injected, over budget, unavailable, unreadable", async () => {
    const sessionId = mintSessionId();
    await seedSkillSession(sessionId, {
      pinned: ["@acme/big", "@acme/gone", "@acme/odd", "@acme/over"],
      // Replaced whole by the claim: a stale verdict does not survive.
      status: { "@acme/gone": { status: "injected", chars: 1 } },
    });
    const res = await postChat(sessionId, undefined, scriptedEngine().engine, {
      permissions: SKILL_TURN_PERMISSIONS,
      dispatch: listedSkillsDispatch([
        { id: "@acme/big", text: "x".repeat(CHAT_SKILLS_CONTENT_BUDGET_CHARS - 10) },
        { id: "@acme/odd", text: "served", listedText: "listed" },
        { id: "@acme/over", text: "y".repeat(20) },
      ]),
    });
    expect(res.status).toBe(200);
    await collectUiChunks(res);
    expect((await sessionSkills(sessionId))?.skillStatus).toEqual({
      "@acme/big": { status: "injected", chars: CHAT_SKILLS_CONTENT_BUDGET_CHARS - 10 },
      "@acme/gone": UNAVAILABLE,
      "@acme/odd": { status: "unreadable", chars: null },
      "@acme/over": { status: "over_budget", chars: 20 },
    });

    await waitForAssistantPersist(sessionId);
  });

  it("injects the skills the history cites, discovery off, pins first and once, with no verdict", async () => {
    const sessionId = mintSessionId();
    await db.insert(chatSessions).values({
      id: sessionId,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      title: null,
      skillDiscovery: false,
      pinnedSkills: ["@acme/pin"],
    });
    const chip = (id: string) => `:skill[${id.split("/")[1]}]{name=${id}}`;
    const dispatch = listedSkillsDispatch([
      { id: "@acme/pin", text: "Pin." },
      { id: "@acme/earlier", text: "Earlier." },
      { id: "@acme/now", text: "Now." },
    ]);
    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine, {
      permissions: SKILL_TURN_PERMISSIONS,
      dispatch,
      history: [
        { id: "h1", role: "user", parts: [{ type: "text", text: `${chip("@acme/earlier")} go` }] },
        { id: "h2", role: "assistant", parts: [{ type: "text", text: "ok" }] },
      ],
      parts: [
        { type: "text", text: `${chip("@acme/now")} ${chip("@acme/pin")} ${chip("@acme/gone")}` },
      ],
    });
    expect(res.status).toBe(200);
    await collectUiChunks(res);
    const system = calls[0]!.system;
    // Pins first, then the most recent message's citations, then the earlier ones.
    const at = (id: string) => system.indexOf(`<skill id="${id}"`);
    expect(at("@acme/pin")).toBeGreaterThan(-1);
    expect(at("@acme/pin")).toBeLessThan(at("@acme/now"));
    expect(at("@acme/now")).toBeLessThan(at("@acme/earlier"));
    expect(system.match(/<skill id="@acme\/pin"/g)).toHaveLength(1);
    expect(system).toContain("`@acme/gone` named in this conversation is not available here");
    const claim = (await tokenInjectedSkills(calls[0]!)) as { skills: Record<string, unknown> };
    expect(Object.keys(claim.skills).sort()).toEqual(["@acme/earlier", "@acme/now", "@acme/pin"]);
    // `skill_status` holds the pins' verdicts alone.
    expect((await sessionSkills(sessionId))?.skillStatus).toEqual({
      "@acme/pin": { status: "injected", chars: 4 },
    });

    await waitForAssistantPersist(sessionId);
  });

  it("runs on the pins it read when the skills PATCH lands while it starts; the next turn reads the PATCH", async () => {
    const sessionId = mintSessionId();
    await seedSkillSession(sessionId, { pinned: ["@acme/a"] });
    let done = false;
    const dispatch = listedSkillsDispatch(
      [
        { id: "@acme/a", text: "Pin A." },
        { id: "@acme/b", text: "Pin B." },
      ],
      async () => {
        if (done) return;
        done = true;
        // Another tab's PATCH, landing while this turn's prompt is built.
        await db
          .update(chatSessions)
          .set({ pinnedSkills: ["@acme/b"] })
          .where(eq(chatSessions.id, sessionId));
      },
    );
    const first = scriptedEngine();
    const res = await postChat(sessionId, undefined, first.engine, {
      permissions: SKILL_TURN_PERMISSIONS,
      dispatch,
    });
    expect(res.status).toBe(200);
    await collectUiChunks(res);
    await waitForAssistantPersist(sessionId);
    expect(first.calls[0]!.system).toContain("Pin A.");
    // The PATCH stands; the claim writes no verdict for the pin it dropped.
    expect(await sessionSkills(sessionId)).toEqual({
      skillDiscovery: true,
      pinnedSkills: ["@acme/b"],
      skillStatus: {},
    });

    const second = scriptedEngine();
    const next = await postChat(sessionId, undefined, second.engine, {
      permissions: SKILL_TURN_PERMISSIONS,
      messageId: "u2",
      dispatch,
    });
    expect(next.status).toBe(200);
    await collectUiChunks(next);
    expect(second.calls[0]!.system).toContain("Pin B.");
    expect(second.calls[0]!.system).not.toContain("Pin A.");

    await waitForAssistantPersist(sessionId);
  });

  describe("a turn refused at or before its claim writes no verdict", () => {
    const stored = {
      pinned: ["@acme/a", "@acme/b"],
      status: {
        "@acme/a": { status: "injected", chars: 1 },
        "@acme/b": { status: "injected", chars: 2 },
      } as Record<string, ChatSkillStatusEntry>,
    };

    async function expectUnchanged(sessionId: string, res: Response, status: number) {
      expect(res.status).toBe(status);
      expect(await sessionSkills(sessionId)).toEqual({
        skillDiscovery: true,
        pinnedSkills: stored.pinned,
        skillStatus: stored.status,
      });
    }

    type Arranged = { overrides: Parameters<typeof postChat>[3]; cleanup?: () => void };
    const cases: Array<
      [label: string, status: number, code: string | null, arrange: (sessionId: string) => Arranged]
    > = [
      [
        "refused before its claim, the concurrency slot held",
        429,
        null,
        () => {
          const previousCap = process.env.CHAT_PI_MAX_CONCURRENCY;
          process.env.CHAT_PI_MAX_CONCURRENCY = "1";
          _resetChatEnvForTests();
          const heldSlot = acquirePiChatSlot();
          return {
            overrides: {},
            cleanup: () => {
              heldSlot?.release();
              if (previousCap === undefined) delete process.env.CHAT_PI_MAX_CONCURRENCY;
              else process.env.CHAT_PI_MAX_CONCURRENCY = previousCap;
              _resetChatEnvForTests();
            },
          };
        },
      ],
      [
        "refused by the admission gate",
        402,
        null,
        () => ({
          overrides: {
            dispatch: listedSkillsDispatch([]),
            checkUsageAllowed: async () => ({
              code: "quota_exceeded",
              message: "Out of credits.",
              status: 402,
            }),
          },
        }),
      ],
      [
        "refused by its claim while another turn is live",
        409,
        "chat_turn_in_flight",
        (sessionId) => ({
          overrides: {
            dispatch: listedSkillsDispatch([], async () => {
              await db
                .update(chatSessions)
                .set({ activeStreamId: "strm_live" })
                .where(eq(chatSessions.id, sessionId));
            }),
          },
        }),
      ],
    ];

    for (const [label, status, code, arrange] of cases) {
      it(`${label} (${status})`, async () => {
        const sessionId = mintSessionId();
        await seedSkillSession(sessionId, stored);
        const { overrides, cleanup } = arrange(sessionId);
        try {
          const res = await postChat(sessionId, undefined, scriptedEngine().engine, {
            permissions: SKILL_TURN_PERMISSIONS,
            ...overrides,
          });
          if (code) expect(await res.clone().json()).toMatchObject({ code });
          await expectUnchanged(sessionId, res, status);
        } finally {
          cleanup?.();
        }
      });
    }
  });

  it("reads a skill's SKILL.md as a plain read: its text stays in the persisted history, nothing is pinned", async () => {
    const sessionId = mintSessionId();
    const SKILL = "@acme/tone";
    const TEXT = "Always answer in haiku.";
    const URI = `skill://${ctx.defaultSpaceId}/acme/tone/tone/SKILL.md`;
    const dispatch = listedSkillsDispatch([{ id: SKILL, text: TEXT }]);

    // Turn 1: the model calls `read_resource` on the listed SKILL.md, through the real tool
    // layer the engine builds, and the result reaches the stream through the real mapper.
    const results: unknown[] = [];
    const loadingEngine: ChatEngine = (input) => {
      const stream = new ReadableStream<UIMessageChunk>({
        async start(controller) {
          const { surfaceKey: _cached, ...platformMcp } = input.platformMcp;
          const tools = await buildPlatformMcpTools({
            ...platformMcp,
            writeChunk: () => {},
            signal: new AbortController().signal,
            turnBudget: { deadlineAt: Date.now() + 60_000, stepCount: () => 0 },
            fileDelivery: { image: true, pdf: true },
          });
          const registered: Array<{
            name: string;
            execute: (id: string, params: unknown) => Promise<unknown>;
          }> = [];
          for (const factory of tools.extensionFactories) {
            factory({ registerTool: (tool: never) => registered.push(tool) } as never);
          }
          const read = registered.find((tool) => tool.name === "read_resource")!;
          const result = await read.execute("call_skill", { uri: URI });
          results.push(result);
          await tools.close();
          const mapper = new PiChatUiStreamMapper();
          for (const chunk of [
            { type: "start", messageId: "asst_load" },
            {
              type: "tool-input-available",
              toolCallId: "call_skill",
              toolName: "read_resource",
              input: { uri: URI },
            },
            ...mapper.map({
              type: "tool_execution_end",
              toolCallId: "call_skill",
              result,
              isError: false,
            } as never),
            { type: "finish", messageMetadata: { appstrate: { turn: TURN_META } } },
          ] as UIMessageChunk[]) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
      return createUIMessageStreamResponse({
        stream: releaseOnClose(stream, () => input.slot.release()),
      });
    };
    const first = await postChat(sessionId, undefined, loadingEngine, {
      permissions: SKILL_TURN_PERMISSIONS,
      dispatch,
    });
    expect(first.status).toBe(200);
    await collectUiChunks(first);
    await waitForAssistantPersist(sessionId);
    expect(results[0]).not.toHaveProperty("persistedContent");
    expect(await sessionSkills(sessionId)).toEqual({
      skillDiscovery: true,
      pinnedSkills: [],
      skillStatus: {},
    });

    // Turn 2 replays the stored thread, as the client re-sends it: the text is in the history,
    // not in the system prompt.
    const stored = await db
      .select({ messageId: chatMessages.messageId, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(asc(chatMessages.seq));
    const history = stored.map(({ messageId, content }) => ({ id: messageId, ...content }));
    expect(JSON.stringify(history)).toContain(TEXT);

    const second = scriptedEngine();
    const next = await postChat(sessionId, undefined, second.engine, {
      permissions: SKILL_TURN_PERMISSIONS,
      messageId: "u2",
      history,
      dispatch,
    });
    expect(next.status).toBe(200);
    await collectUiChunks(next);
    expect(second.calls[0]!.system).not.toContain(`<skill id="${SKILL}"`);
    expect(JSON.stringify(second.calls[0]!.messages)).toContain(TEXT);

    await waitForAssistantPersist(sessionId);
  });

  it("answers 400 to a body field the turn does not know, or malformed pins", async () => {
    for (const body of [
      { not_a_field: true },
      { skill_mode: "strict" },
      { pinned_skills: ["@a/1"] },
      { pins: ["not-a-package-id"] },
    ]) {
      const res = await postChat(mintSessionId(), undefined, scriptedEngine().engine, { body });
      expect(res.status).toBe(400);
    }
  });

  it("keeps `skills:read` on the token with discovery on", async () => {
    const sessionId = mintSessionId();
    await db.insert(chatSessions).values({
      id: sessionId,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      title: null,
      skillDiscovery: true,
      pinnedSkills: [],
    });
    const { engine, calls } = scriptedEngine();
    const res = await postChat(sessionId, undefined, engine, {
      permissions: new Set(["mcp:read", "mcp:invoke", "skills:read"]),
    });
    expect(res.status).toBe(200);
    await collectUiChunks(res);
    expect(await tokenPermissions(calls[0]!)).toEqual([
      "chat:read",
      "chat:write",
      "mcp:invoke",
      "mcp:read",
      "skills:read",
    ]);
    expect(calls[0]!.system).toContain("call `read_resource` with that URI verbatim");

    await waitForAssistantPersist(sessionId);
  });

  it("teaches no skill on a turn without `skills:read`", async () => {
    // The platform MCP server below DOES list a skill, so every absence asserted
    // is the turn's own gate, not an empty fixture: neither the persona nor the
    // block names a skill.
    const sessionId = mintSessionId();
    await db.insert(chatSessions).values({
      id: sessionId,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      title: null,
    });
    const skillReads: string[] = [];
    const catalogued: FakeSkill = {
      space: ctx.defaultSpaceId,
      id: "@acme/catalogued",
      description: "Catalogued",
      version: null,
    };
    const dispatch = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/mcp/")) skillReads.push(url.pathname);
      return scriptedDispatch(undefined, catalogued)(req);
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
    for (const absent of ["## Skills", "@acme/catalogued", "read_resource", "listSkills"]) {
      expect(system).not.toContain(absent);
    }

    await waitForAssistantPersist(sessionId);
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
    expect(input.system).toContain(
      buildSystemPrompt(turnCapabilities(() => false, [])).slice(0, 64),
    );
    expect(input.system).toContain(CONTEXT_ORG_MARKER);
    expect(input.platformMcp.url).toContain(`/api/mcp/o/${encodeURIComponent(ctx.orgId)}`);
    expect(input.platformMcp.headers.Authorization).toMatch(/^Bearer /);
    // The cached MCP surface is keyed on exactly what the bearer carries: a key
    // cut from any other list would hand this turn another caller's descriptors.
    expect(input.platformMcp.surfaceKey).toBe(
      platformMcpSurfaceKey(input.platformMcp.url, await tokenPermissions(input), [defaultReach()]),
    );
    // The MCP transport is the platform's in-process dispatch, not global
    // `fetch` — JSON-RPC hops that used to open real loopback sockets back
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
    expect(assistant).toMatchObject({ sessionId, content: { role: "assistant" } });
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

  describe("the usage the engine reports", () => {
    /** One turn whose engine reports usage once; what the platform's usage writer received. */
    async function reportedUsage(overrides: {
      apiShape?: string;
      resolveChatModel: ChatPlatformDeps["resolveChatModel"];
    }): Promise<ChatUsageRecord[]> {
      const records: ChatUsageRecord[] = [];
      const { engine } = scriptedEngine();
      const res = await postChat(
        mintSessionId(),
        undefined,
        (input) => {
          input.recordUsage({
            orgId: input.orgId,
            userId: input.userId,
            chatSessionId: input.chatSessionId,
            presetId: input.presetId,
            modelId: input.modelBinding.model.id,
            apiShape: "anthropic-messages",
            inputTokens: 3,
            outputTokens: 5,
            cost: null,
          });
          return engine(input);
        },
        {
          ...overrides,
          recordChatUsage: async (record) => {
            records.push(record);
          },
        },
      );
      expect(res.status).toBe(200);
      await res.text();
      return records;
    }

    // The platform derives the turn's payer from this credential.
    it("reaches the usage writer with the subscription credential the turn spends", async () => {
      const records = await reportedUsage({
        apiShape: "anthropic-messages",
        resolveChatModel: async () => ({
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
            credentialId: "cred_subscription_turn",
          },
        }),
      });

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        orgId: ctx.orgId,
        userId: ctx.user.id,
        presetId: MODEL_PRESET_ID,
        credentialId: "cred_subscription_turn",
      });
    });

    it("reaches the usage writer with no credential on a proxy-bound turn", async () => {
      const records = await reportedUsage({
        resolveChatModel: async () => ({ subscription: false }),
      });

      expect(records).toHaveLength(1);
      expect(records[0]!.credentialId).toBeNull();
    });
  });

  describe("the composer's inline-run model switch", () => {
    it("hands the run launcher the turn's model when on", async () => {
      const { engine, calls } = scriptedEngine();
      const res = await postChat(mintSessionId(), undefined, engine, {
        body: { inline_runs_use_chat_model: true },
      });
      expect(res.status).toBe(200);
      await collectUiChunks(res);
      // No override in the body: the run gets the model alone, and its own defaults.
      expect(calls[0]!.platformMcp.inlineRunModel).toEqual({ modelId: MODEL_PRESET_ID });
    });

    it("leaves inline runs on the default model when absent or off", async () => {
      for (const body of [{}, { inline_runs_use_chat_model: false }]) {
        const { engine, calls } = scriptedEngine();
        const res = await postChat(mintSessionId(), undefined, engine, { body });
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        expect(calls[0]!.platformMcp.inlineRunModel).toBeUndefined();
      }
    });
  });

  it("hands the engine a byte-identical system prompt across turns", async () => {
    const first = scriptedEngine();
    await postChat(mintSessionId(), undefined, first.engine);
    const second = scriptedEngine();
    await postChat(mintSessionId(), undefined, second.engine);

    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]!.system).toBe(first.calls[0]!.system);
    expect(first.calls[0]!.system).toContain(CONTEXT_ORG_MARKER);
  }, 20_000);

  describe("the composer's package-authoring switch", () => {
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
      packageAuthoring?: boolean,
      listedSkill?: FakeSkill,
    ) {
      const { engine, calls } = scriptedEngine();
      const res = await postChat(mintSessionId(), undefined, engine, {
        permissions,
        ...(packageAuthoring === undefined ? {} : { packageAuthoring }),
        ...(listedSkill === undefined ? {} : { listedSkill }),
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
        "chat:read",
        "chat:write",
        "mcp:invoke",
        "mcp:read",
        "runs:read",
      ]);
      expect(system).toContain(INLINE_MARKER);
      expect(system).not.toContain(REDUCED_MARKER);
    });

    it("drops only `agents:write` from the token and the inline teaching when off", async () => {
      const { token, system } = await turn(BUILDER, false);
      expect(token).toEqual([
        "agents:read",
        "agents:run",
        "chat:read",
        "chat:write",
        "mcp:invoke",
        "mcp:read",
        "runs:read",
      ]);
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
      expect(token).toEqual(["agents:run", "chat:read", "chat:write", "mcp:read"]);
      expect(system).not.toContain(INLINE_MARKER);
    });

    it("teaches inline composition only with `agents:run` as well", async () => {
      const { token, system } = await turn(new Set(["agents:write"]), true);
      expect(token).toEqual(["agents:write", "chat:read", "chat:write", "mcp:read"]);
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
      // Skills are the counterpoint: `read_resource` needs no dispatch, so they stay.
      const withSkill: FakeSkill = {
        space: ctx.defaultSpaceId,
        id: SKILL_ID,
        description: "Research",
        version: "1.2.0",
      };
      const { system } = await turn(
        new Set(["mcp:read", "agents:write", "skills:read"]),
        true,
        withSkill,
      );
      expect(system).not.toContain(SKILLS_MARKER);
      expect(system).toContain(SKILL_ID);
      expect(system).toContain("call `read_resource` with that URI verbatim");
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

  describe("a turn across the acting set", () => {
    let spaceB: string;
    /** Reached for reading the chat and the tools, but never chatted in: outside the acting set. */
    let spaceC: string;
    let reach: ReachableSpaceGrant[];

    beforeEach(async () => {
      spaceB = (await seedSpace({ orgId: ctx.orgId, name: "Beta" })).id;
      spaceC = (await seedSpace({ orgId: ctx.orgId, name: "Gamma" })).id;
      reach = [
        reachableSpace({
          id: ctx.defaultSpaceId,
          name: "Alpha",
          role: "operator",
          permissions: ["chat:read", "chat:write", "mcp:read", "mcp:invoke", "agents:run"],
        }),
        reachableSpace({
          id: spaceB,
          name: "Beta",
          role: "builder",
          permissions: [
            "chat:read",
            "chat:write",
            "mcp:read",
            "mcp:invoke",
            "agents:write",
            "skills:write",
          ],
        }),
        reachableSpace({
          id: spaceC,
          name: "Gamma",
          role: "viewer",
          permissions: ["chat:read", "mcp:read", "runs:read-all"],
        }),
      ];
    });

    /** The turn `postChat` runs over `reachable`. */
    async function turn(
      sessionId: string,
      overrides: Parameters<typeof postChat>[3] = {},
      reachable: ReachableSpaceGrant[] = reach,
    ) {
      const { engine, calls } = scriptedEngine();
      const res = await postChat(sessionId, undefined, engine, { ...overrides, reachable });
      return { res, calls };
    }

    it("hands the engine the organization endpoint and a ceiling over the acting set, not the whole reach", async () => {
      const sessionId = mintSessionId();
      const { res, calls } = await turn(sessionId);
      expect(res.status).toBe(200);
      await collectUiChunks(res);
      await waitForAssistantPersist(sessionId);

      const input = calls[0]!;
      const url = new URL(input.platformMcp.url);
      expect(url.pathname).toBe(`/api/mcp/o/${ctx.orgId}`);
      expect(url.searchParams.get("renders_cards")).toBe("true");
      // A permission held in Beta alone is in the ceiling: each call is decided in the space it
      // names, which recomputes `(org ∪ role) ∩ ceiling` there. Gamma is outside the acting set:
      // its `runs:read-all` is not lent to the others.
      expect(await tokenPermissions(input)).toEqual(
        [
          "agents:run",
          "agents:write",
          "chat:read",
          "chat:write",
          "mcp:invoke",
          "mcp:read",
          "skills:write",
        ].sort(),
      );
      // The bearer allowlists the turn's spaces (not the whole reach), keyed with the surface
      // they list, and the session is persisted.
      expect(await tokenSpaceIds(input)).toEqual([ctx.defaultSpaceId, spaceB]);
      expect(input.platformMcp.surfaceKey).toBe(
        platformMcpSurfaceKey(
          input.platformMcp.url,
          await tokenPermissions(input),
          input.platformMcp.organization.spaces,
        ),
      );
      const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
      // Started from the overview: no origin space, no limit.
      expect(row).toMatchObject({
        id: sessionId,
        orgId: ctx.orgId,
        userId: ctx.user.id,
        spaceId: null,
        restricted: false,
      });
    });

    it("narrows the union by the authoring switch", async () => {
      const { res, calls } = await turn(mintSessionId(), { packageAuthoring: false });
      expect(res.status).toBe(200);
      await collectUiChunks(res);
      const granted = await tokenPermissions(calls[0]!);
      expect(granted).not.toContain("agents:write");
      expect(granted).not.toContain("skills:write");
      expect(granted).toContain("agents:run");
    });

    describe("what the spaces hold", () => {
      const touched = async (sessionId: string) =>
        (
          await db
            .select({ spaceId: chatSessionSpaces.spaceId })
            .from(chatSessionSpaces)
            .where(eq(chatSessionSpaces.sessionId, sessionId))
        ).map((row) => row.spaceId);
      /** The reach with `agents:run` in Beta too, so its agents are read there. */
      const runningInBoth = () =>
        reach.map((space) =>
          space.id === spaceB
            ? { ...space, permissions: [...space.permissions, "agents:run"] }
            : space,
        );
      /** get_me per space: one agent in each space `agentIn` names, nothing elsewhere. */
      const holding = (agentIn: Record<string, string>, asked: string[]) =>
        fakePlatformMcp(
          {
            getMe: (spaceId) => {
              asked.push(spaceId);
              const agent = agentIn[spaceId];
              return meBody({
                space: { id: spaceId },
                agents: {
                  data: agent ? [fullAgent(agent, agent)] : [],
                  truncated: false,
                  total: agent ? 1 : 0,
                },
              });
            },
          },
          scriptedDispatch(),
        );

      it("details the origin space alone and records nothing", async () => {
        const sessionId = mintSessionId();
        const asked: string[] = [];
        const { res, calls } = await turn(
          sessionId,
          {
            dispatch: holding(
              { [ctx.defaultSpaceId]: "@acme/alpha", [spaceB]: "@acme/beta" },
              asked,
            ),
            body: { spaceId: ctx.defaultSpaceId },
          },
          runningInBoth(),
        );
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        await waitForAssistantPersist(sessionId);
        expect(asked).toEqual([ctx.defaultSpaceId]);
        expect(calls[0]!.system).toContain("- `@acme/alpha` — in Alpha");
        expect(calls[0]!.system).not.toContain("@acme/beta");
        expect(await touched(sessionId)).toEqual([]);
      });

      it("details every space when the turn asks, recording each that showed an entry before the model reads it", async () => {
        const sessionId = mintSessionId();
        const asked: string[] = [];
        const { engine: scripted, calls } = scriptedEngine();
        // Queued when inference starts: a touch written later would land after this read.
        let touchedAtInference: Promise<string[]> | undefined;
        const engine: ChatEngine = (input) => {
          touchedAtInference = touched(sessionId);
          return scripted(input);
        };
        const res = await postChat(sessionId, undefined, engine, {
          dispatch: holding({ [spaceB]: "@acme/beta" }, asked),
          body: { spaceId: ctx.defaultSpaceId, context_all_spaces: true },
          reachable: runningInBoth(),
        });
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        await waitForAssistantPersist(sessionId);
        // Gamma is outside the acting set: never read.
        expect(asked.sort()).toEqual([ctx.defaultSpaceId, spaceB].sort());
        expect(calls[0]!.system).toContain("- `@acme/beta` — in Beta");
        // Beta put an agent into the conversation, recorded before inference; Alpha is its origin.
        expect(await touchedAtInference).toEqual([spaceB]);
      });

      describe("with the caller's personal space in reach", () => {
        let personalId: string;
        let withPersonal: ReachableSpaceGrant[];
        beforeEach(async () => {
          personalId = (
            await seedSpace({
              orgId: ctx.orgId,
              name: "Mon espace",
              ownerUserId: ctx.user.id,
              visibility: "private",
            })
          ).id;
          withPersonal = [
            ...runningInBoth(),
            reachableSpace({
              id: personalId,
              name: "Mon espace",
              role: "admin",
              personal: true,
              permissions: ["chat:read", "chat:write", "mcp:read", "mcp:invoke", "agents:run"],
            }),
          ];
        });

        it("details it without being asked, and records nothing", async () => {
          const sessionId = mintSessionId();
          const asked: string[] = [];
          const { res, calls } = await turn(
            sessionId,
            {
              dispatch: holding({ [personalId]: "@acme/mine", [spaceB]: "@acme/beta" }, asked),
              body: { spaceId: ctx.defaultSpaceId },
            },
            withPersonal,
          );
          expect(res.status).toBe(200);
          await collectUiChunks(res);
          await waitForAssistantPersist(sessionId);
          expect(asked.sort()).toEqual([ctx.defaultSpaceId, personalId].sort());
          expect(calls[0]!.system).toContain("- `@acme/mine` — in Mon espace");
          expect(calls[0]!.system).not.toContain("@acme/beta");
          expect(await touched(sessionId)).toEqual([]);
        });

        it("is read with every space but, unlike them, never recorded", async () => {
          const sessionId = mintSessionId();
          const asked: string[] = [];
          const res = await postChat(sessionId, undefined, scriptedEngine().engine, {
            dispatch: holding({ [personalId]: "@acme/mine", [spaceB]: "@acme/beta" }, asked),
            body: { spaceId: ctx.defaultSpaceId, context_all_spaces: true },
            reachable: withPersonal,
          });
          expect(res.status).toBe(200);
          await collectUiChunks(res);
          await waitForAssistantPersist(sessionId);
          expect(asked.sort()).toEqual([ctx.defaultSpaceId, spaceB, personalId].sort());
          expect(await touched(sessionId)).toEqual([spaceB]);
        });
      });

      it("records nothing for every space when its claim refuses the turn", async () => {
        const sessionId = mintSessionId();
        await ensureSession(sessionId, ctx.orgId, ctx.user.id, [ctx.defaultSpaceId, spaceB]);
        const { engine, calls } = scriptedEngine();
        const res = await postChat(sessionId, undefined, engine, {
          dispatch: holding({ [spaceB]: "@acme/beta" }, []),
          body: { context_all_spaces: true },
          reachable: runningInBoth(),
          resolveChatModel: async () => {
            await db
              .update(chatSessions)
              .set({ activeStreamId: "strm_live" })
              .where(eq(chatSessions.id, sessionId));
            return { subscription: false };
          },
        });
        expect(res.status).toBe(409);
        expect(calls).toEqual([]);
        expect(await touched(sessionId)).toEqual([]);
      });

      it("details a space the conversation touched earlier without being asked", async () => {
        const sessionId = mintSessionId();
        await ensureSession(sessionId, ctx.orgId, ctx.user.id, [ctx.defaultSpaceId, spaceB]);
        await db.insert(chatSessionSpaces).values({ sessionId, spaceId: spaceB, orgId: ctx.orgId });
        const asked: string[] = [];
        const { res, calls } = await turn(
          sessionId,
          { dispatch: holding({ [spaceB]: "@acme/beta" }, asked) },
          runningInBoth(),
        );
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        await waitForAssistantPersist(sessionId);
        expect(asked).toEqual([spaceB]);
        expect(calls[0]!.system).toContain("- `@acme/beta` — in Beta");
      });

      it("records no space whose details showed no entry", async () => {
        const sessionId = mintSessionId();
        const { res } = await turn(
          sessionId,
          {
            dispatch: holding({}, []),
            body: { spaceId: ctx.defaultSpaceId, context_all_spaces: true },
          },
          runningInBoth(),
        );
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        await waitForAssistantPersist(sessionId);
        expect(await touched(sessionId)).toEqual([]);
      });
    });

    describe("the origin space (`spaceId`)", () => {
      const touchedBy = async (sessionId: string) =>
        (
          await db
            .select({ spaceId: chatSessionSpaces.spaceId })
            .from(chatSessionSpaces)
            .where(eq(chatSessionSpaces.sessionId, sessionId))
        )
          .map((row) => row.spaceId)
          .sort();
      const rowOf = async (sessionId: string) =>
        (await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)))[0]!;

      it("is named in the prompt as a fact, and is stored as the origin of a new conversation", async () => {
        const sessionId = mintSessionId();
        const { engine, calls } = scriptedEngine();
        const res = await postChat(sessionId, undefined, engine, {
          reachable: reach,
          body: { spaceId: spaceB },
        });
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        await waitForAssistantPersist(sessionId);

        expect(calls[0]!.system).toContain(`This conversation was opened in Beta (\`${spaceB}\`).`);
        // The default pins nothing: the turn acts on the organization endpoint.
        expect(new URL(calls[0]!.platformMcp.url).pathname).toBe(`/api/mcp/o/${ctx.orgId}`);
        expect(await rowOf(sessionId)).toMatchObject({ spaceId: spaceB, restricted: false });
        // The origin space is touched by definition, recorded nowhere else.
        expect(await touchedBy(sessionId)).toEqual([]);
      });

      it("names no space in the overview, even with an organization default, storing no origin", async () => {
        const sessionId = mintSessionId();
        const { engine, calls } = scriptedEngine();
        const res = await postChat(sessionId, undefined, engine, {
          reachable: reach.map((space) =>
            space.id === spaceB ? { ...space, isDefault: true } : space,
          ),
        });
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        await waitForAssistantPersist(sessionId);
        expect(calls[0]!.system).not.toContain("This conversation was opened in");
        expect(calls[0]!.system).not.toContain("default space");
        expect(await rowOf(sessionId)).toMatchObject({ spaceId: null, restricted: false });
      });

      it("names no space from the overview: nothing stored", async () => {
        const sessionId = mintSessionId();
        const { engine, calls } = scriptedEngine();
        const res = await postChat(sessionId, undefined, engine, { reachable: reach });
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        await waitForAssistantPersist(sessionId);
        expect(calls[0]!.system).not.toContain("This conversation was opened in");
        expect(await rowOf(sessionId)).toMatchObject({ spaceId: null, restricted: false });
        expect(await touchedBy(sessionId)).toEqual([]);
      });

      it("is read from the turn body only when the turn creates the conversation", async () => {
        const sessionId = mintSessionId();
        await ensureSession(
          sessionId,
          ctx.orgId,
          ctx.user.id,
          [ctx.defaultSpaceId, spaceB],
          undefined,
          () => ({
            spaceId: ctx.defaultSpaceId,
            restricted: false,
          }),
        );
        const { engine, calls } = scriptedEngine();
        const res = await postChat(sessionId, undefined, engine, {
          reachable: reach,
          body: { spaceId: spaceB, restricted: true },
        });
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        await waitForAssistantPersist(sessionId);
        // The stable origin is the default, and the body's space touched and limited nothing.
        expect(calls[0]!.system).toContain(
          `This conversation was opened in Alpha (\`${ctx.defaultSpaceId}\`)`,
        );
        expect([...(await tokenSpaceIds(calls[0]!))!].sort()).toEqual(
          [ctx.defaultSpaceId, spaceB].sort(),
        );
        expect(await rowOf(sessionId)).toMatchObject({
          spaceId: ctx.defaultSpaceId,
          restricted: false,
        });
        expect(await touchedBy(sessionId)).toEqual([]);
      });

      it("does not validate them on a turn of an existing conversation", async () => {
        const sessionId = mintSessionId();
        await ensureSession(sessionId, ctx.orgId, ctx.user.id, [ctx.defaultSpaceId]);
        const { engine } = scriptedEngine();
        // Outside the acting set and a limit without a space: refused when creating, ignored here.
        const res = await postChat(sessionId, undefined, engine, {
          reachable: reach,
          body: { spaceId: spaceC, restricted: true },
        });
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        await waitForAssistantPersist(sessionId);
        expect(await rowOf(sessionId)).toMatchObject({ spaceId: null, restricted: false });
      });

      it("refuses an invalid origin with a 400 naming the field, before anything is written", async () => {
        // The rule is `conversationOrigin`'s (chat-sessions.test.ts); this is the turn's door to it.
        for (const [body, param] of [
          [{ spaceId: spaceC }, "spaceId"],
          [{ restricted: true }, "restricted"],
        ] as const) {
          const sessionId = mintSessionId();
          const { engine, calls } = scriptedEngine();
          const res = await postChat(sessionId, undefined, engine, { reachable: reach, body });
          expect(res.status).toBe(400);
          expect(((await res.json()) as { param?: string }).param).toBe(param);
          expect(calls).toEqual([]);
          expect(
            await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)),
          ).toEqual([]);
        }
      });
    });

    describe("a limited conversation (`restricted`)", () => {
      const limitedTurn = async (
        sessionId: string,
        overrides: Parameters<typeof postChat>[3] = {},
        reachable: ReachableSpaceGrant[] = reach,
      ) => {
        const { engine, calls } = scriptedEngine();
        const res = await postChat(sessionId, undefined, engine, {
          reachable,
          body: { spaceId: spaceB, restricted: true },
          ...overrides,
        });
        return { res, calls };
      };

      it("acts on the organization endpoint in its origin space alone, under that space's set", async () => {
        const sessionId = mintSessionId();
        const { res, calls } = await limitedTurn(sessionId);
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        await waitForAssistantPersist(sessionId);

        const input = calls[0]!;
        expect(new URL(input.platformMcp.url).pathname).toBe(`/api/mcp/o/${ctx.orgId}`);
        // Beta's set, narrowed by the turn: nothing of Alpha (`agents:run`) is lent to it.
        expect(await tokenPermissions(input)).toEqual(
          [
            "agents:write",
            "chat:read",
            "chat:write",
            "mcp:invoke",
            "mcp:read",
            "skills:write",
          ].sort(),
        );
        expect(input.platformMcp.organization.spaces.map((space) => space.id)).toEqual([spaceB]);
        // The bearer allowlists the origin space alone, so the surface is keyed on it alone.
        expect(await tokenSpaceIds(input)).toEqual([spaceB]);
        expect(input.platformMcp.surfaceKey).toBe(
          platformMcpSurfaceKey(
            input.platformMcp.url,
            await tokenPermissions(input),
            input.platformMcp.organization.spaces,
          ),
        );
        const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
        expect(row).toMatchObject({ spaceId: spaceB, restricted: true });
      });

      it("keeps of the org-level half only the reads it needs; an unlimited turn keeps it all", async () => {
        const orgHalf = new Set(["org:read", "models:read", "proxies:write", "members:invite"]);
        const withOrg = reach.map((space) => ({
          ...space,
          permissions: [...space.permissions, ...orgHalf],
        }));
        const limited = await limitedTurn(mintSessionId(), { orgHalf }, withOrg);
        expect(limited.res.status).toBe(200);
        await collectUiChunks(limited.res);
        const limitedSet = await tokenPermissions(limited.calls[0]!);
        expect(limitedSet).toEqual(
          [
            "agents:write",
            "chat:read",
            "chat:write",
            "mcp:invoke",
            "mcp:read",
            "models:read",
            "org:read",
            "skills:write",
          ].sort(),
        );
        // The prompt lists the turn's set: no org-level write is offered to the model either.
        expect(limited.calls[0]!.system).not.toContain("proxies:write");

        const { engine, calls } = scriptedEngine();
        const res = await postChat(mintSessionId(), undefined, engine, {
          reachable: withOrg,
          orgHalf,
        });
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        expect(await tokenPermissions(calls[0]!)).toEqual(
          expect.arrayContaining(["proxies:write", "members:invite", "org:read"]),
        );
      });

      it("tells the model it is limited to that space", async () => {
        const { res, calls } = await limitedTurn(mintSessionId());
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        expect(calls[0]!.system).toContain(
          `This conversation was opened in Beta (\`${spaceB}\`) and is limited to it`,
        );
      });

      it("touches its origin space with nothing recorded, the only space its tools may name", async () => {
        const sessionId = mintSessionId();
        const { res, calls } = await limitedTurn(sessionId);
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        await waitForAssistantPersist(sessionId);
        const { organization } = calls[0]!.platformMcp;
        await organization.touch(spaceB);
        expect(organization.spaces.map((space) => space.id)).toEqual([spaceB]);
        expect(await db.select().from(chatSessionSpaces)).toEqual([]);
      });

      it("hands an attachment its origin space alone", async () => {
        const requests: ChatAttachmentRequest[] = [];
        const { res } = await limitedTurn(mintSessionId(), {
          parts: [
            { type: "text", text: "lis ceci" },
            { type: "file", url: "upload://upl_x", mediaType: "text/plain", filename: "b.txt" },
          ],
          resolveChatAttachment: async (request) => {
            requests.push(request);
            return {
              uri: "appfile://file_abcdefgh",
              name: "b.txt",
              mime: "text/plain",
              size: 3,
              spaceId: spaceB,
            };
          },
        });
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        expect(requests[0]!.spaces.map((space) => space.id)).toEqual([spaceB]);
      });

      it("is refused with a 403, before anything runs, once the author can no longer act in the origin space", async () => {
        const sessionId = mintSessionId();
        await ensureSession(sessionId, ctx.orgId, ctx.user.id, [spaceB], undefined, () => ({
          spaceId: spaceB,
          restricted: true,
        }));
        // Still read in Beta (the conversation opens), but no longer chatted in.
        const readOnlyBeta = [
          { ...reach[0]! },
          { ...reach[1]!, permissions: ["chat:read", "mcp:read"] },
        ];
        const refused = await limitedTurn(sessionId, { body: {} }, readOnlyBeta);
        expect(refused.res.status).toBe(403);
        expect(refused.calls).toEqual([]);
        // Unlimited, the same conversation still answers over the acting set that remains.
        await db
          .update(chatSessions)
          .set({ restricted: false })
          .where(eq(chatSessions.id, sessionId));
        const open = await limitedTurn(sessionId, { body: {} }, readOnlyBeta);
        expect(open.res.status).toBe(200);
        await collectUiChunks(open.res);
      });
    });

    it("refuses a turn on a conversation that touched a space its author no longer reads", async () => {
      const sessionId = mintSessionId();
      await ensureSession(sessionId, ctx.orgId, ctx.user.id, []);
      await db.insert(chatSessionSpaces).values({ sessionId, spaceId: spaceB, orgId: ctx.orgId });

      const lostBeta = [{ ...reach[0]! }, { ...reach[1]!, permissions: ["mcp:read"] }];
      const refused = await turn(sessionId, {}, lostBeta);
      expect(refused.res.status).toBe(404);
      expect(refused.calls).toEqual([]);
      // Still reading Beta: the same session answers.
      const open = await turn(sessionId);
      expect(open.res.status).toBe(200);
      await collectUiChunks(open.res);
    });

    describe("recording the spaces it touches", () => {
      const touched = async (sessionId: string) =>
        (
          await db
            .select({ spaceId: chatSessionSpaces.spaceId })
            .from(chatSessionSpaces)
            .where(eq(chatSessionSpaces.sessionId, sessionId))
        ).map((row) => row.spaceId);

      async function organizationOf(sessionId: string, reachable: ReachableSpaceGrant[] = reach) {
        const { res, calls } = await turn(sessionId, {}, reachable);
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        await waitForAssistantPersist(sessionId);
        const input = calls[0]!;
        return input.platformMcp.organization;
      }

      it("signs the origin and records only the space the platform enters", async () => {
        const sessionId = mintSessionId();
        const { res, calls } = await turn(sessionId, {
          body: { spaceId: ctx.defaultSpaceId },
          parts: [{ type: "text", text: "Beta" }],
        });
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        await waitForAssistantPersist(sessionId);
        const mcp = calls[0]!.platformMcp;
        expect(mcp.organization).toMatchObject({ originSpaceId: ctx.defaultSpaceId });
        const resolved = await chatLoopbackStrategy.authenticate({
          headers: new Headers(mcp.headers),
        } as never);
        expect(resolved?.extra).toMatchObject({ originSpaceId: ctx.defaultSpaceId });
        const record = resolved?.extra?.beforeMcpSpaceAct;
        expect(typeof record).toBe("function");
        if (typeof record !== "function") throw new Error("missing recorder");
        await expect(record(spaceC)).rejects.toThrow("outside the turn");
        await record(ctx.defaultSpaceId);
        expect(await touched(sessionId)).toEqual([]);
        await record(spaceB);
        expect(await touched(sessionId)).toEqual([spaceB]);
      });

      it("records a named space once, notifies on growth only, and reads the space of a URI", async () => {
        const sessionId = mintSessionId();
        const organization = await organizationOf(sessionId);
        expect(organization.spaces.map((space) => space.id)).toEqual([ctx.defaultSpaceId, spaceB]);

        const notified = spyOn(db, "execute");
        try {
          await organization.touch(spaceB);
          await organization.touch(spaceB);
          const signals = notified.mock.calls.filter((call) =>
            JSON.stringify(call[0]).includes("chat_session_update"),
          );
          expect(signals).toHaveLength(1);
        } finally {
          notified.mockRestore();
        }
        expect(await touched(sessionId)).toEqual([spaceB]);

        // Only files are looked up: a missing one, or no file at all, has no space.
        expect(await organization.fileSpace("appfile://file_missing00")).toBeUndefined();
        expect(await organization.fileSpace("https://example.com")).toBeUndefined();
      });

      it("places an existing file in its space, even one outside the turn's, which no call records", async () => {
        const fileId = "file_gammareport0";
        await db.insert(files).values({
          id: fileId,
          orgId: ctx.orgId,
          spaceId: spaceC,
          purpose: "user_upload",
          userId: ctx.user.id,
          storageKey: `files/${spaceC}/${fileId}/report.txt`,
          name: "report.txt",
          mime: "text/plain",
          size: 1,
          sha256: "deadbeef",
        });
        const organization = await organizationOf(mintSessionId());
        // Gamma is reached but outside the acting set.
        expect(await organization.fileSpace(`appfile://${fileId}`)).toBe(spaceC);
        expect(spaceIdRefusal(organization.spaces, spaceC)).toMatchObject({
          code: "unknown_space",
        });
      });

      it("leaves a space outside the acting set out of the turn's spaces and of its bearer: unknown, reached without the grants, or unreadable", async () => {
        const turned = async (reachable: ReachableSpaceGrant[]) => {
          const { res, calls } = await turn(mintSessionId(), {}, reachable);
          expect(res.status).toBe(200);
          await collectUiChunks(res);
          return calls[0]!;
        };
        // Gamma is reached with `chat:read` and `mcp:read` but cannot chat in it.
        const input = await turned(reach);
        expect(input.platformMcp.organization.spaces.map((space) => space.id)).toEqual([
          ctx.defaultSpaceId,
          spaceB,
        ]);
        expect(await tokenSpaceIds(input)).toEqual([ctx.defaultSpaceId, spaceB]);
        expect(await tokenSpaceIds(input)).not.toContain(spaceC);

        // Reached with `mcp:read` and `chat:write` alone: acting there would hide the session
        // from its author, so it is no place the turn acts.
        const unreadable = await turned([
          reach[0]!,
          { ...reach[1]!, permissions: ["mcp:read", "chat:write"] },
        ]);
        expect(await tokenSpaceIds(unreadable)).toEqual([ctx.defaultSpaceId]);
      });

      describe("skills across spaces", () => {
        const TONE = "@acme/tone";
        const ONLY_B = "@acme/only-b";
        const uriIn = (space: string, id: string) =>
          `skill://${space}/${id.slice(1)}/${id.split("/")[1]}/SKILL.md`;
        const bodyOf = (space: string, id: string) => `${id} as read in ${space}`;

        /** The skills the organization endpoint lists, in the order it lists them. */
        const skillsDispatch = (listed: Array<[space: string, id: string]>, read: string[] = []) =>
          fakePlatformMcp(
            {
              skills: listed.map(([space, id]) => ({
                space,
                id,
                text: bodyOf(space, id),
                description: `${id} in ${space}`,
              })),
              onMethod: (method, params) => {
                if (method === "resources/read") read.push(params?.uri as string);
              },
            },
            scriptedDispatch(),
          );

        /** The reach with `skills:read` on both spaces, and `chat:write` where `chatIn` names it. */
        const reachWith = (chatIn: string[]): ReachableSpaceGrant[] =>
          reach.map((space) => ({
            ...space,
            permissions: [
              ...new Set([
                ...space.permissions.filter((permission) => permission !== "chat:write"),
                "skills:read",
                ...(chatIn.includes(space.id) ? ["chat:write"] : []),
              ]),
            ],
          }));

        it("lists one skill per package, the first space in reach order winning, each with its own URI", async () => {
          // The server lists Beta's copy first: only the reach order decides.
          const { res, calls } = await turn(
            mintSessionId(),
            {
              dispatch: skillsDispatch([
                [spaceB, TONE],
                [spaceB, ONLY_B],
                [ctx.defaultSpaceId, TONE],
              ]),
            },
            reachWith([ctx.defaultSpaceId, spaceB]),
          );
          expect(res.status).toBe(200);
          await collectUiChunks(res);
          const system = calls[0]!.system;
          expect(system).toContain(
            `- \`${ONLY_B}\` (v1.0.0) \`${uriIn(spaceB, ONLY_B)}\` — ${ONLY_B} in ${spaceB}\n` +
              `- \`${TONE}\` (v1.0.0) \`${uriIn(ctx.defaultSpaceId, TONE)}\``,
          );
          expect(system).not.toContain(uriIn(spaceB, TONE));
          expect(system).not.toContain("<skill id=");
        });

        it("injects a pinned skill and lists the others of the turn's spaces, never the pinned one twice", async () => {
          const read: string[] = [];
          const { res, calls } = await turn(
            mintSessionId(),
            {
              dispatch: skillsDispatch(
                [
                  [ctx.defaultSpaceId, TONE],
                  [spaceB, ONLY_B],
                ],
                read,
              ),
              body: { pins: [ONLY_B] },
            },
            reachWith([ctx.defaultSpaceId, spaceB]),
          );
          expect(res.status).toBe(200);
          await collectUiChunks(res);
          const system = calls[0]!.system;
          expect(read).toEqual([uriIn(spaceB, ONLY_B)]);
          expect(system).toContain(`<skill id="${ONLY_B}"`);
          expect(system).toContain(`- \`${TONE}\``);
          expect(system).not.toContain(`- \`${ONLY_B}\``);
          expect(await tokenPermissions(calls[0]!)).toContain("skills:read");
        });

        it("reads no skill of a space outside the acting set, listed or pinned", async () => {
          const read: string[] = [];
          const { res, calls } = await turn(
            mintSessionId(),
            {
              dispatch: skillsDispatch(
                [
                  [ctx.defaultSpaceId, TONE],
                  [spaceB, ONLY_B],
                ],
                read,
              ),
            },
            // Beta is reached with `skills:read` but never chatted in.
            reachWith([ctx.defaultSpaceId]),
          );
          expect(res.status).toBe(200);
          await collectUiChunks(res);
          expect(calls[0]!.system).toContain(`\`${TONE}\``);
          expect(calls[0]!.system).not.toContain(ONLY_B);

          const pinned = await turn(
            mintSessionId(),
            {
              dispatch: skillsDispatch([[spaceB, ONLY_B]], read),
              body: { pins: [ONLY_B] },
            },
            reachWith([ctx.defaultSpaceId]),
          );
          await collectUiChunks(pinned.res);
          expect(read).toEqual([]);
          expect(pinned.calls[0]!.system).toContain("is not available here");
        });

        it("injects a pinned skill of another space and binds its claim to that space", async () => {
          const read: string[] = [];
          const { res, calls } = await turn(
            mintSessionId(),
            {
              dispatch: skillsDispatch(
                [
                  [ctx.defaultSpaceId, TONE],
                  [spaceB, ONLY_B],
                ],
                read,
              ),
              body: { pins: [ONLY_B] },
            },
            reachWith([ctx.defaultSpaceId, spaceB]),
          );
          expect(res.status).toBe(200);
          await collectUiChunks(res);
          expect(read).toEqual([uriIn(spaceB, ONLY_B)]);
          expect(calls[0]!.system).toContain(
            `<skill id="${ONLY_B}" uri="${uriIn(spaceB, ONLY_B)}" version="1.0.0">\n${bodyOf(spaceB, ONLY_B)}\n</skill>`,
          );
          expect(await tokenInjectedSkills(calls[0]!)).toEqual({
            skills: { [ONLY_B]: { definition: "published", version: "1.0.0", spaceId: spaceB } },
          });
        });

        it("lists a limited conversation's origin space's skills alone", async () => {
          const { res, calls } = await turn(
            mintSessionId(),
            {
              dispatch: skillsDispatch([
                [spaceB, ONLY_B],
                [ctx.defaultSpaceId, TONE],
              ]),
              body: { spaceId: spaceB, restricted: true },
            },
            reachWith([ctx.defaultSpaceId, spaceB]),
          );
          expect(res.status).toBe(200);
          await collectUiChunks(res);
          expect(calls[0]!.system).toContain(`\`${ONLY_B}\``);
          expect(calls[0]!.system).not.toContain(TONE);
        });
      });

      it("hands an attachment the acting set, and records the space it resolves in before materializing", async () => {
        const sessionId = mintSessionId();
        const requests: ChatAttachmentRequest[] = [];
        const { res } = await turn(sessionId, {
          parts: [
            { type: "text", text: "lis ceci" },
            { type: "file", url: "upload://upl_x", mediaType: "text/plain", filename: "b.txt" },
          ],
          resolveChatAttachment: async (request) => {
            requests.push(request);
            await request.beforeResolve(spaceB);
            return {
              uri: "appfile://file_abcdefgh",
              name: "b.txt",
              mime: "text/plain",
              size: 3,
              spaceId: spaceB,
            };
          },
        });
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        await waitForAssistantPersist(sessionId);

        expect(requests[0]!.spaces.map((space) => space.id)).toEqual([ctx.defaultSpaceId, spaceB]);
        expect([...requests[0]!.spaces[1]!.permissions]).toContain("agents:write");
        expect(await touched(sessionId)).toEqual([spaceB]);
      });
    });
  });
  describe("an agent launch of the composer", () => {
    const LAUNCH = (request: string) =>
      `# Run Appstrate agent \`@acme/summarizer\`\n\n## Request\n\n${request || "(none)"}\n`;
    const launchPart = (extra: Record<string, unknown> = {}) => ({
      type: "data-agent-prompt",
      data: { name: "run-summarizer", title: "Summarizer", ...extra },
    });

    /** A platform MCP server serving one launch prompt; records each `prompts/get`. */
    const promptsDispatch = (gets: Array<Record<string, unknown>>) =>
      fakePlatformMcp(
        {
          capabilities: { prompts: {} },
          getPrompt: (params) => {
            gets.push(params);
            if (params.name !== "run-summarizer") return undefined;
            const args = (params.arguments ?? {}) as { request?: string };
            return {
              messages: [
                { role: "user", content: { type: "text", text: LAUNCH(args.request ?? "") } },
              ],
            };
          },
        },
        scriptedDispatch(),
      );

    /** The structured turn Pi builds from what the handler handed the engine. */
    const modelTurn = (input: PiChatInput) => {
      const { api, provider, id } = input.modelBinding.model;
      return buildStructuredPiTurn(
        input.messages,
        { api, provider, model: id },
        { estimateTokens: () => 1, baseTokens: 0, fileDelivery: { image: false, pdf: false } },
      );
    };

    const rowsOf = async (sessionId: string) =>
      (await db.select().from(chatMessages).where(eq(chatMessages.sessionId, sessionId))).map(
        (row) => row.content as UIMessage,
      );

    it("resolves the prompt with the typed text, persists the expansion and shows it to the model", async () => {
      const sessionId = mintSessionId();
      const gets: Array<Record<string, unknown>> = [];
      const { engine, calls } = scriptedEngine();
      const res = await postChat(sessionId, undefined, engine, {
        dispatch: promptsDispatch(gets),
        parts: [{ type: "text", text: "résume ma boîte" }, launchPart()],
      });
      expect(res.status).toBe(200);
      await collectUiChunks(res);
      await waitForAssistantPersist(sessionId);

      expect(gets).toEqual([{ name: "run-summarizer", arguments: { request: "résume ma boîte" } }]);
      // Persisted: the typed text as typed, the part with the server's expansion.
      const [user] = await rowsOf(sessionId);
      expect(user!.parts).toEqual([
        { type: "text", text: "résume ma boîte" },
        {
          type: "data-agent-prompt",
          data: {
            name: "run-summarizer",
            title: "Summarizer",
            text: LAUNCH("résume ma boîte"),
          },
        },
      ]);
      // The model reads the expansion, once, not the typed text beside it.
      expect(modelTurn(calls[0]!).prompt).toBe(LAUNCH("résume ma boîte").trim());
    });

    it("resolves a launch typed with no text, titling the conversation from it", async () => {
      const gets: Array<Record<string, unknown>> = [];
      const sessionId = mintSessionId();
      const res = await postChat(sessionId, undefined, scriptedEngine().engine, {
        dispatch: promptsDispatch(gets),
        parts: [launchPart()],
      });
      expect(res.status).toBe(200);
      await collectUiChunks(res);
      await waitForAssistantPersist(sessionId);
      expect(gets).toEqual([{ name: "run-summarizer", arguments: { request: "" } }]);
      const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
      expect(session?.title).toBe("Summarizer");
    });

    it("keeps the directives as typed, and resolves the request with them read as /label, the agent's own left out", async () => {
      const sessionId = mintSessionId();
      const gets: Array<Record<string, unknown>> = [];
      const { engine, calls } = scriptedEngine();
      const typed =
        ":agent[Summarizer]{name=run-summarizer} résume en suivant :skill[tone]{name=@acme/tone}";
      const res = await postChat(sessionId, undefined, engine, {
        dispatch: promptsDispatch(gets),
        parts: [{ type: "text", text: typed }, launchPart()],
      });
      expect(res.status).toBe(200);
      await collectUiChunks(res);
      await waitForAssistantPersist(sessionId);

      expect(gets).toEqual([
        { name: "run-summarizer", arguments: { request: "résume en suivant /tone" } },
      ]);
      const [user] = await rowsOf(sessionId);
      expect(user!.parts[0]).toEqual({ type: "text", text: typed });
      const turn = modelTurn(calls[0]!);
      expect(turn.prompt).toBe(LAUNCH("résume en suivant /tone").trim());
      expect(turn.prompt).not.toContain(":skill[");
      const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
      expect(session?.title).toBe("/Summarizer résume en suivant /tone");
    });

    it("shows the model a skill directive as /label, never as the composer's syntax", async () => {
      const sessionId = mintSessionId();
      const { engine, calls } = scriptedEngine();
      const res = await postChat(sessionId, undefined, engine, {
        parts: [{ type: "text", text: "reformule avec :skill[tone]{name=@acme/tone} stp" }],
      });
      expect(res.status).toBe(200);
      await collectUiChunks(res);
      await waitForAssistantPersist(sessionId);
      expect(modelTurn(calls[0]!).prompt).toBe("reformule avec /tone stp");
      // The stored row keeps what was typed: the thread draws the chip from it.
      const [user] = await rowsOf(sessionId);
      expect((user!.parts[0] as { text: string }).text).toBe(
        "reformule avec :skill[tone]{name=@acme/tone} stp",
      );
    });

    it("answers 400 to a name the server does not serve, writing nothing and freeing the conversation", async () => {
      const sessionId = mintSessionId();
      const { engine, calls } = scriptedEngine();
      const res = await postChat(sessionId, undefined, engine, {
        dispatch: promptsDispatch([]),
        parts: [
          { type: "text", text: "go" },
          { type: "data-agent-prompt", data: { name: "run-ghost", title: "Ghost" } },
        ],
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_request");
      expect(calls).toEqual([]);
      expect(await db.select().from(chatMessages)).toEqual([]);
      const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
      expect(session?.activeStreamId ?? null).toBeNull();
    });

    it("answers 502 when the platform fails to answer the launch, before the slot and the claim, leaving nothing behind", async () => {
      const sessionId = mintSessionId();
      const { engine, calls } = scriptedEngine();
      const res = await postChat(sessionId, undefined, engine, {
        dispatch: async (req) =>
          new URL(req.url).pathname === "/api/models"
            ? modelsResponse()
            : new Response("boom", { status: 500 }),
        parts: [{ type: "text", text: "go" }, launchPart()],
      });
      expect(res.status).toBe(502);
      expect(calls).toEqual([]);
      expect(await db.select().from(chatMessages)).toEqual([]);
      const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
      expect(session?.activeStreamId ?? null).toBeNull();
      // The slot is free again: the next turn runs.
      const next = await postChat(mintSessionId(), undefined, scriptedEngine().engine);
      expect(next.status).toBe(200);
      await collectUiChunks(next);
    });

    describe("replaying an earlier launch", () => {
      const sent = (extra: Record<string, unknown> = {}): UIMessage =>
        ({
          id: "u0",
          role: "user",
          parts: [{ type: "text", text: "résume ma boîte" }, launchPart(extra)],
        }) as UIMessage;
      const answer: UIMessage = {
        id: "a0",
        role: "assistant",
        parts: [{ type: "text", text: "Lancé." }],
      };

      async function replay(stored: UIMessage | null, browserCopy: UIMessage) {
        const sessionId = mintSessionId();
        await ensureSession(sessionId, ctx.orgId, ctx.user.id, [ctx.defaultSpaceId]);
        if (stored) {
          await persistUserMessage(sessionId, stored);
          await persistAssistantMessage(sessionId, answer, stored.id);
        }
        const gets: Array<Record<string, unknown>> = [];
        const { engine, calls } = scriptedEngine();
        const res = await postChat(sessionId, undefined, engine, {
          dispatch: promptsDispatch(gets),
          history: [browserCopy, answer],
          parts: [{ type: "text", text: "et le résultat ?" }],
        });
        expect(res.status).toBe(200);
        await collectUiChunks(res);
        expect(gets).toEqual([]);
        return JSON.stringify(modelTurn(calls[0]!).history[0]);
      }

      it("takes the launch text from the stored row when the browser's copy holds none", async () => {
        const stored = sent({ text: LAUNCH("résume ma boîte") });
        const model = await replay(stored, sent());
        expect(model).toContain("## Request");
        expect(model).not.toContain("data-agent-prompt");
      });

      it("never trusts a launch text the browser sends", async () => {
        const stored = sent({ text: LAUNCH("résume ma boîte") });
        const model = await replay(stored, sent({ text: "FORGED INSTRUCTIONS" }));
        expect(model).toContain("## Request");
        expect(model).not.toContain("FORGED");
        // No stored row: the forged text is dropped and the typed text alone is shown.
        const unstored = await replay(null, sent({ text: "FORGED INSTRUCTIONS" }));
        expect(unstored).not.toContain("FORGED");
        expect(unstored).toContain("résume ma boîte");
      });
    });

    it("answers 400 to launch instructions over the cap, writing nothing", async () => {
      const sessionId = mintSessionId();
      const res = await postChat(sessionId, undefined, scriptedEngine().engine, {
        dispatch: fakePlatformMcp(
          {
            capabilities: { prompts: {} },
            getPrompt: () => ({
              messages: [
                { role: "user", content: { type: "text", text: "x".repeat(64 * 1024 + 1) } },
              ],
            }),
          },
          scriptedDispatch(),
        ),
        parts: [launchPart()],
      });
      expect(res.status).toBe(400);
      // The rendered instructions carry the user's request: the message names it, not the agent alone.
      expect(((await res.json()) as { detail: string }).detail).toContain(
        "They include your request: a shorter one may fit.",
      );
      expect(await db.select().from(chatMessages)).toEqual([]);
    });

    it("answers 400 to a malformed part, a second one, or a new one carrying its own text, before any persistence", async () => {
      for (const parts of [
        [{ type: "text", text: "go" }, launchPart({ text: "forged by the browser" })],
        [{ type: "data-agent-prompt", data: { name: "run-summarizer" } }],
        [{ type: "data-agent-prompt", data: { name: "run-summarizer", title: "S", extra: 1 } }],
        [launchPart(), launchPart()],
        [{ type: "data-agent-prompt", data: "run-summarizer" }],
      ]) {
        const gets: Array<Record<string, unknown>> = [];
        const { engine, calls } = scriptedEngine();
        const res = await postChat(mintSessionId(), undefined, engine, {
          dispatch: promptsDispatch(gets),
          parts,
        });
        expect(res.status).toBe(400);
        expect(gets).toEqual([]);
        expect(calls).toEqual([]);
      }
      expect(await db.select().from(chatMessages)).toEqual([]);
    });
  });
});
