// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/chat` — the conversational loop, ported from the appstrate-chat
 * satellite (routes/chat.ts) with two changes:
 *
 *   1. Identity: the satellite carried two audience-bound OAuth tokens; the
 *      module forwards the caller's own headers on loopback calls (self.ts).
 *   2. Persistence: server-authoritative. This route writes the user turn
 *      before inference and the assistant turn when the stream finalizes
 *      (see persistence.ts). Generation runs through a resumable producer
 *      (resumable.ts) that drains to completion independently of the client
 *      connection, so leaving the conversation mid-inference no longer drops
 *      messages. The client history adapter is now load-only.
 *
 * Inference goes through the llm-proxy for API-key models and natively at
 * the provider for OAuth subscriptions (no key here); tool calls dispatch
 * through `/api/mcp` (auth + RBAC re-applied in-process).
 */

import type { Context } from "hono";
import type { UIMessage } from "ai";
import { z } from "zod";
import { parseBody, invalidRequest } from "@appstrate/core/api-errors";
import { isAttachmentUri } from "@appstrate/core/file-uri";
import { logger } from "./logger.ts";
import { listModels, pickModel, resolveDefaultSpaceId } from "./llm.ts";
import { platformMcpUrl } from "./platform-mcp.ts";
import { selfOrigin, forwardedHeaders } from "./self.ts";
import { mintLoopbackToken, mintMcpLoopbackToken } from "./loopback-auth.ts";
import { materializeUserAttachments } from "./attachments.ts";
import { runPiChat, type PiChatInput } from "./pi-chat/engine.ts";
import { resolvePiChatModelBinding } from "./pi-chat/model-binding.ts";
import { acquirePiChatSlot, chatCapacityResponse } from "./pi-chat/concurrency.ts";
import { SYSTEM_PROMPT, buildCallerContextBlock, type ChatEnv } from "./prompt.ts";
export type { ChatEnv } from "./prompt.ts";
import { finalizeChatStream } from "./finalize-stream.ts";
import { ensureSession, persistUserMessage, persistAssistantMessage } from "./persistence.ts";
import { registerStopController, unregisterStopController } from "./stop-registry.ts";
import { setActiveStream, clearActiveStream } from "./resumable.ts";
import type { ChatPlatformDeps } from "./platform-services.ts";
import type { UsageRejection } from "@appstrate/core/module";
import { classifyClientTurnError, clientTurnErrorMarker } from "./turn-error.ts";
import {
  ModelGenerationError,
  modelGenerationSettingsSchema,
  resolveModelGenerationSettings,
} from "@appstrate/core/model-generation";

/**
 * RFC 9457 `401` returned when the chosen subscription model's oauth credential
 * is dead (revoked/expired-beyond-refresh). The client renders a reconnect
 * prompt rather than the engine launching a session that would 401 upstream.
 */
function subscriptionReconnectResponse(): Response {
  return new Response(
    JSON.stringify({
      type: "https://docs.appstrate.dev/errors/subscription-reconnect",
      title: "Reconnection required",
      status: 401,
      detail: "The selected model's subscription credential expired or was revoked.",
      code: "needs_reconnection",
    }),
    { status: 401, headers: { "content-type": "application/problem+json" } },
  );
}

/**
 * RFC 9457 response for a turn blocked by the platform admission gate
 * (`beforeUsage`, chat context). The hook's status flows through — a metering
 * module returns 402 (payment required) when the org is over its soft cap.
 */
function usageRejectionResponse(rejection: UsageRejection): Response {
  const status = rejection.status ?? 403;
  return new Response(
    JSON.stringify({
      type: "https://docs.appstrate.dev/errors/usage-not-allowed",
      title: "Usage not allowed",
      status,
      detail: rejection.message,
      code: rejection.code,
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

/**
 * TTL for the Pi-engine path's loopback bearer. The Pi chat engine
 * opens its platform MCP client once per turn with these headers, so the token
 * must outlive the whole turn (up to CHAT_MAX_STEPS steps, each able to
 * long-poll a run's status for ~55 s). 30 min is a generous ceiling for a
 * single interactive turn.
 */
const ENGINE_LOOPBACK_TTL_MS = 30 * 60_000;

/**
 * The engine that drives a turn. Injectable ONLY so tests can script a turn
 * without standing up a real Pi session against a real provider — production
 * always gets {@link runPiChat}. There is no second engine to select.
 */
export type ChatEngine = (input: PiChatInput) => Response;

/**
 * Roles the engine's history projection actually handles. `buildStructuredPiTurn`
 * (`pi-chat/structured-session.ts`) keeps `user` and `assistant` and DROPS every
 * other role silently, so anything else must be refused at the door rather than
 * accepted and discarded.
 */
const CHAT_MESSAGE_ROLES = new Set(["user", "assistant"]);

// The client (assistant-ui / useChat) posts the full thread plus optional
// session/model/context extras. `messages` are UIMessages; the shape itself is
// the AI SDK's and stays loose here, with two tightenings the engine cannot
// make for us:
//   - `role` MUST be one of {@link CHAT_MESSAGE_ROLES}. Nothing legitimate
//     sends another: the composer only produces user turns, and a reload
//     replays what the server persisted — user or assistant, a server-authored
//     notice included (persistence.ts stores it as `assistant`).
//   - any `file` part MUST reference an `upload://` or `appfile://` URI. That
//     rejects inline `data:` bytes and arbitrary URLs in the chat channel
//     (attachments flow only through the file store, never inline).
export const chatStreamSchema = z.object({
  id: z.string().optional(),
  messages: z
    .array(z.unknown())
    .min(1, "messages must not be empty")
    .superRefine((messages, ctx) => {
      messages.forEach((message, i) => {
        const role = (message as { role?: unknown }).role;
        if (typeof role !== "string" || !CHAT_MESSAGE_ROLES.has(role)) {
          ctx.addIssue({
            code: "custom",
            message: "Message role must be 'user' or 'assistant'.",
            path: [i, "role"],
          });
        }
        const parts = (message as { parts?: unknown }).parts;
        if (!Array.isArray(parts)) return;
        parts.forEach((part, j) => {
          if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "file") {
            return;
          }
          const url = (part as { url?: unknown }).url;
          if (!isAttachmentUri(url)) {
            ctx.addIssue({
              code: "custom",
              message: "File attachment URI must be an 'upload://' or 'appfile://' URI.",
              path: [i, "parts", j, "url"],
            });
          }
        });
      });
    }),
  modelId: z.string().optional(),
  generation: modelGenerationSettingsSchema.optional(),
});

function clientErrorMessage(error: unknown): string {
  return clientTurnErrorMarker(classifyClientTurnError(error));
}

export async function handleChatStream(
  c: Context<ChatEnv>,
  deps: ChatPlatformDeps,
  runEngine: ChatEngine = runPiChat,
): Promise<Response> {
  const orgId = c.get("orgId");
  const user = c.get("user");
  const orgRole = c.get("orgRole") ?? "member";
  const body = parseBody(chatStreamSchema, await c.req.json().catch(() => null));
  const messages = body.messages as UIMessage[];
  logger.info("chat turn", { turns: messages.length });

  const sessionId = body.id;
  let lastMessage = messages[messages.length - 1] as UIMessage | undefined;

  // Session id to stamp on this turn's `llm_usage` row. Only set when the row
  // for that session is (or will be) persisted this turn — the same condition
  // that runs `ensureSession` below — so the ledger's `chat_session_id` FK is
  // always satisfiable. Ephemeral turns record un-attributed usage (null).
  const meteringSessionId = sessionId && lastMessage?.id ? sessionId : null;

  // Persist the session ROW up front, BEFORE the (potentially multi-second)
  // inference preamble (model resolve + MCP boot). The client mints the id and
  // creates conversations lazily, so the sidebar shows a new conversation
  // optimistically on send; without an early `ensureSession` the row would not
  // exist until after the preamble, and the sidebar's reconciling poll could
  // fire first and clobber the optimistic entry (flicker). Creating the row here
  // closes that window. Ownership is enforced inside `ensureSession` (404 on a
  // foreign-tenant id collision). The user MESSAGE and the `active_stream_id`
  // marker are still written later, just before generation — keeping the
  // "generating" flag off until we're committed to a turn, so a preamble error
  // can't strand the session as perpetually generating.
  if (sessionId && lastMessage?.id) {
    await ensureSession(sessionId, orgId, user.id);
  }

  const origin = selfOrigin();
  const headers = forwardedHeaders(c);
  // Single platform-call seam: re-enter the platform app in-process (or loopback
  // fetch when not wired) for every PLATFORM read the turn makes (/api/models,
  // /api/spaces, and the MCP hops; `/api/me/context` dispatches directly).
  // Auth + RBAC run each hop.
  //
  // Inference is the exception and does NOT ride this seam: the proxy binding
  // hands pi-ai a `baseUrl` string built from `origin`, and pi-ai opens a real
  // loopback socket to it. That is why `CHAT_SELF_ORIGIN` must actually resolve
  // on this host, and why the binding needs a bearer *minter* (see below) rather
  // than a header captured once.
  const platformFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    deps.dispatch(new Request(input, init))) as typeof fetch;

  const turnStart = Date.now();

  // The proxy surfaces are bearer-only (cookies refused — CSRF model):
  // inference loopback calls carry a short-lived token only this process
  // can mint, scoped to llm-proxy:call + models:read. The MCP session keeps
  // the caller's own credentials (full RBAC fidelity on tool calls).
  //
  // The token lives 60 s, but a turn fans out into many inference calls over
  // many steps (with a run long-poll blocking for ~55s between them), so the
  // proxy binding gets a *minter* and re-mints a fresh bearer immediately before
  // every provider request. The static header below is for the one-shot calls
  // (listModels) that fire immediately on this same line.
  const mintInferenceAuth = () =>
    mintLoopbackToken(
      { userId: user.id, email: user.email, name: user.name, orgId, orgRole },
      // The session id rides the SIGNED loopback claims (not a header) so the
      // llm-proxy can attribute a proxy-routed turn's usage to the chat session
      // without trusting anything spoofable.
      { chatSessionId: meteringSessionId },
    );
  const inferenceHeaders: Record<string, string> = {
    Authorization: `Bearer ${mintInferenceAuth()}`,
    "X-Org-Id": orgId,
  };

  // ── Preamble phase A (parallel) ──────────────────────────────────────────
  // The model list and the default space id are independent reads, so
  // fire them together rather than back-to-back. `listModels` resolves the row
  // the turn binds to; the space id scopes the MCP + integration reads that follow. Pin from the header when the caller
  // already supplied one (no lookup needed).
  const modelId = c.req.header("X-Model-Id") ?? body.modelId;
  const pinnedSpaceId = c.req.header("x-space-id");
  const phaseAStart = Date.now();
  const [models, spaceId] = await Promise.all([
    listModels(origin, inferenceHeaders, platformFetch),
    pinnedSpaceId
      ? Promise.resolve(pinnedSpaceId)
      : resolveDefaultSpaceId(origin, headers, orgId, platformFetch),
  ]);
  const chosen = pickModel(models, modelId);
  let generationSettings;
  try {
    generationSettings = resolveModelGenerationSettings({
      capabilities: chosen.generation,
      override: body.generation,
    });
  } catch (error) {
    if (error instanceof ModelGenerationError) throw invalidRequest(error.message);
    throw error;
  }
  const phaseAMs = Date.now() - phaseAStart;
  logger.info("model resolved", {
    model: chosen.id,
    modelId: chosen.modelId,
    providerId: chosen.providerId,
  });

  // Materialize the new turn's composer attachments into durable, session-scoped
  // files and rewrite each `upload://` (or already-`appfile://`) file part
  // to its stable `appfile://` URI, BEFORE the turn is persisted (persistence
  // stores only `appfile://`) and before it reaches the engine (the model is
  // shown the attachment as a text line, never a raw file URL). Needs the session
  // (the file container) and the resolved space id, both known here;
  // nothing has been opened yet, so a quota/cap rejection surfaces as a clean
  // error with no MCP/stop-controller to leak. Only the last message can carry
  // fresh uploads — earlier turns already hold rewritten `appfile://` URIs.
  if (sessionId && lastMessage && spaceId) {
    lastMessage = await materializeUserAttachments(lastMessage, (uri) =>
      deps.resolveChatAttachment({
        orgId,
        spaceId,
        userId: user.id,
        chatSessionId: sessionId,
        uri,
      }),
    );
    messages[messages.length - 1] = lastMessage;
  }

  // Which credential the turn spends. The platform resolves the chosen model
  // row: an API-key/unknown provider yields `{ subscription: false }` and the
  // turn is bound to the llm-proxy; an oauth2 provider yields the real upstream
  // binding + a fresh access token, or a reconnect signal when its credential is
  // dead. Both ride the SAME engine — this fact drives admission and the Pi
  // binding, never a choice of loop.
  const subscription = await deps.resolveChatModel(orgId, chosen.id);
  const isSubscription = subscription.subscription;

  // Admission gate — EVERY turn. The platform
  // resolves system-provided vs. org-owned server-side and dispatches
  // `beforeUsage` (chat context) with that fact; a metering module quotes it and
  // decides.
  //
  // A subscription turn used to skip this entirely, on the reasoning that it
  // spends the user's OWN credential (`credentialSource` `org`) and therefore
  // costs nothing. That is the module's call to make, not the platform's: the
  // turn is driven by the IN-PROCESS Pi engine, so the platform funds its
  // compute even when it funds no inference, and a module gating on
  // subscription status must be able to refuse it. `subscription` reports the
  // credential mode, and the platform derives the credential source from it.
  //
  // Gated BEFORE the phase-B preamble so a rejected turn opens no MCP session
  // and persists no user message.
  const rejection = await deps.checkUsageAllowed({
    orgId,
    presetId: chosen.id,
    sessionId: meteringSessionId,
    subscription: isSubscription,
  });
  if (rejection) return usageRejectionResponse(rejection);

  // ── Preamble phase B ─────────────────────────────────────────────────────
  // Only the caller-context block. There is NO platform-MCP probe here: the Pi
  // engine opens its OWN MCP connection from `platformMcp.url`, and the MCP
  // server's instructions reach the model through that handshake. Probing here
  // would be a second handshake we'd immediately close — 2 round-trips wasted on
  // the TTFT path. We pass `platformMcp` optimistically; if the `mcp` module is
  // absent the engine just gets no tools.
  const phaseBStart = Date.now();
  const contextBlock = await buildCallerContextBlock(c, {
    origin,
    headers,
    spaceId,
    user,
    deps,
    // UI language forwarded by the client; validated/defaulted in the builder.
    locale: c.req.header("X-Chat-Locale"),
  });
  const phaseBMs = Date.now() - phaseBStart;

  // Assemble the system prompt: the tool-grounding prompt, with no inline MCP
  // instructions — the engine's own MCP handshake delivers them.
  //
  // The operation-index policy is NOT applied here. The index only ever enters a
  // prompt through the MCP server's `instructions`, which this route no longer
  // fetches; the engine appends them and applies the policy itself
  // (`pi-chat/engine.ts`). Re-applying it to this prompt matched nothing — and
  // could only misfire, since the context block below carries org-authored agent
  // names and would be truncated at any that happened to spell the heading.
  let system = SYSTEM_PROMPT;
  if (contextBlock) system += `\n\n${contextBlock}`;

  logger.info("chat preamble", {
    // Which credential the turn spends. One engine drives them both.
    credentialMode: isSubscription ? "oauth2" : "api-key",
    providerId: chosen.providerId,
    phaseAMs,
    phaseBMs,
    preambleMs: Date.now() - turnStart,
  });

  // Resolve the model binding and reserve capacity before the user message or
  // the active-stream marker is written, so a dead credential, an unsupported
  // family or a saturated process leaves no half-written turn behind. Once
  // acquired, the slot is transferred to the engine, which releases it when the
  // response stream closes.
  const resolution = resolvePiChatModelBinding({
    model: chosen,
    subscription,
    origin,
    mintBearer: mintInferenceAuth,
  });
  if (resolution.status === "needs-reconnection") {
    // The oauth credential is dead → tell the client to reconnect rather than
    // launching a session that would 401 upstream.
    return subscriptionReconnectResponse();
  }
  if (resolution.status !== "ready") {
    throw invalidRequest(`Model family "${chosen.apiShape}" is not supported by the chat.`);
  }
  const slot = acquirePiChatSlot();
  if (!slot) return chatCapacityResponse();
  const modelBinding = resolution.binding;

  // ── Server-authoritative persistence + resumable streaming ───────────────
  // Persist the user turn BEFORE inference; the assistant turn is persisted when
  // the stream finalizes (in `finalize` below). Generation runs through a
  // resumable producer that drains to completion independently of the client, so
  // leaving the conversation mid-inference can no longer drop messages.
  // Per-turn resumable stream id. It is the key for both the resumable producer
  // (live reconnect) and the stop registry, and is stored on the session as
  // `active_stream_id` so a reloaded client's resume GET can find the live turn.
  const streamId = crypto.randomUUID();

  // The session row was already ensured up front (before the preamble). Persist
  // the user turn and mark the in-flight stream now, just before generation.
  let userMessageId: string | undefined;
  if (sessionId && lastMessage?.id) {
    try {
      userMessageId = await persistUserMessage(sessionId, lastMessage);
      // Mark the in-flight stream so a mid-inference reload can reconnect to it.
      await setActiveStream(sessionId, streamId);
    } catch (err) {
      // The concurrency slot is already reserved but generation has not started,
      // so neither `finalize` (teardown via onSettled) nor `failCleanup` (defined
      // below) owns it yet. Release it on this error path before rethrowing, or
      // one slot leaks per failed turn.
      slot.release();
      throw err;
    }
  }

  // Generation abort is DECOUPLED from the request connection: a client
  // disconnect must NOT cancel generation (that was the data-loss bug). Only an
  // explicit stop (POST /api/chat/sessions/:id/stop) aborts this controller.
  const generation = new AbortController();
  registerStopController(streamId, generation);

  // Tee the engine stream into a resumable producer (decoupled from the client)
  // and persist the assistant turn when it finalizes — both run to completion
  // regardless of the client; the persist task is tracked for graceful shutdown.
  // See finalize-stream.ts for the disconnect-survival guarantee + its test.
  const finalize = (engineResponse: Response): Promise<Response> =>
    finalizeChatStream({
      engineResponse,
      streamId,
      precedingMessageId: userMessageId ?? null,
      onAssistant:
        sessionId && userMessageId
          ? (assistant, preceding) => persistAssistantMessage(sessionId, assistant, preceding)
          : undefined,
      onSettled: () => {
        unregisterStopController(streamId);
        // Fire-and-forget teardown — swallow rejections so a failed DB update
        // can't surface as an unhandled rejection.
        if (sessionId) void clearActiveStream(sessionId, streamId).catch(() => {});
      },
    });

  // Teardown for the failure path below: if the engine throws BEFORE `finalize`
  // takes over (which owns teardown via `onSettled`), we must still release the
  // stop controller, the concurrency slot, and clear the in-flight marker (else
  // the session is stuck "generating" with a dead stream id). `release()` is
  // idempotent, so folding it in here makes the slot leak-proof structurally
  // instead of depending on every engine failure path remembering to release.
  const failCleanup = async () => {
    unregisterStopController(streamId);
    slot.release();
    if (sessionId) await clearActiveStream(sessionId, streamId).catch(() => {});
  };

  // Drive the turn. OAuth bindings keep the real access token in memory;
  // API-key bindings carry only the inert proxy key and mint a fresh loopback
  // bearer for every llm-proxy call.
  //
  // The engine opens its OWN platform MCP connection (`/api/mcp/o/:org`), and
  // run_and_wait hits platform run routes with these headers. It must NEVER
  // receive the caller's raw cookie/Authorization (reusable far beyond chat).
  // Hand it a short-lived, process-local bearer carrying EXACTLY the caller's
  // already-resolved permissions (full RBAC fidelity, zero amplification) and
  // NOT first-party-loopback (can't be replayed against the inference proxy).
  const mcpToken = mintMcpLoopbackToken(
    {
      userId: user.id,
      email: user.email,
      name: user.name,
      orgId,
      orgRole,
      permissions: [...(c.get("permissions") ?? [])],
    },
    { ttlMs: ENGINE_LOOPBACK_TTL_MS },
  );
  const mcpHeaders: Record<string, string> = {
    Authorization: `Bearer ${mcpToken}`,
    "x-org-id": orgId,
  };
  if (spaceId) mcpHeaders["x-space-id"] = spaceId;
  try {
    return await finalize(
      runEngine({
        slot,
        modelBinding,
        presetId: chosen.id,
        orgId,
        userId: user.id,
        chatSessionId: meteringSessionId,
        messages,
        system,
        generation: generationSettings,
        platformMcp: {
          url: platformMcpUrl(origin, orgId),
          headers: mcpHeaders,
          // Same in-process seam the preamble reads through: the engine's three
          // MCP hops re-enter the platform app directly instead of opening real
          // loopback sockets back into this process. Auth and RBAC still run on
          // every hop, so the scoped bearer above is exactly as load-bearing.
          fetch: platformFetch,
        },
        // Decoupled from the request connection (see `generation` above).
        abortSignal: generation.signal,
        onError: clientErrorMessage,
        // Fire-and-forget metering — never blocks or fails the turn.
        recordUsage: (record) => {
          void deps.recordChatUsage(record).catch((err) => {
            logger.warn("chat usage metering failed", { err: String(err) });
          });
        },
      }),
    );
  } catch (err) {
    await failCleanup();
    throw err;
  }
}
