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
 * Inference goes through the llm-proxy (no key here); tool calls dispatch
 * through `/api/mcp` (auth + RBAC re-applied in-process).
 */

import type { Context } from "hono";
import {
  streamText,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  type FinishReason,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { z } from "zod";
import { parseBody, invalidRequest } from "@appstrate/core/api-errors";
import { isAttachmentUri } from "@appstrate/core/document-uri";
import { logger } from "./logger.ts";
import { applyOperationIndexPolicy } from "./operation-index.ts";
export { applyOperationIndexPolicy } from "./operation-index.ts";
import { listModels, pickModel, modelFromFamily, resolveDefaultApplicationId } from "./llm.ts";
import { openPlatformMcp, platformMcpUrl } from "./platform-mcp.ts";
import { selfOrigin, forwardedHeaders } from "./self.ts";
import { mintLoopbackToken, mintMcpLoopbackToken } from "./loopback-auth.ts";
import { buildTranscriptPrompt } from "./transcript.ts";
import { materializeUserAttachments, messagesWithAttachmentsAsText } from "./attachments.ts";
import { runPiSubscriptionChat } from "./pi-chat/engine.ts";
import { SYSTEM_PROMPT, buildCallerContextBlock, type ChatEnv } from "./prompt.ts";
export type { ChatEnv } from "./prompt.ts";
import { finalizeChatStream } from "./finalize-stream.ts";
import { ensureSession, persistUserMessage, persistAssistantMessage } from "./persistence.ts";
import { registerStopController, unregisterStopController } from "./stop-registry.ts";
import { setActiveStream, clearActiveStream } from "./resumable.ts";
import type { ChatPlatformDeps } from "./platform-services.ts";
import type { UsageRejection } from "@appstrate/core/module";
import {
  CHAT_FINAL_STEP_SYSTEM_PROMPT,
  CHAT_MAX_STEPS,
  CHAT_TOOL_STEP_BUDGET,
  CHAT_TURN_DEADLINE_MS,
  formatTurnBudgetNote,
  isFinalChatStep,
  mergeTurnMetadata,
  type ChatMessageMetadata,
  type ChatTurnFinishReason,
} from "@appstrate/core/chat-turn-metadata";
import {
  ChatTurnDeadlineError,
  resolveTurnClosure,
  turnDeadlineNoticeText,
  turnNoticeChunks,
} from "./turn-closure.ts";

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
      detail: "Reconnectez votre abonnement — la connexion a expiré ou été révoquée.",
      code: "needs_reconnection",
      needsReconnection: true,
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

type ConvertedModelMessages = Awaited<ReturnType<typeof convertToModelMessages>>;

/**
 * The system prompt as a cache-controlled `SystemModelMessage`, passed to
 * `streamText` via the canonical `instructions` field (NOT at the head of
 * `messages`). The platform MCP instructions carry a generated operation index
 * (several KB, re-sent on every one of the up-to-CHAT_MAX_STEPS inference calls
 * in a turn). OpenAI auto-caches the prefix; the ai-sdk Anthropic providers need
 * an explicit `cache_control` breakpoint or they'd pay the index in full each
 * step. The breakpoint MUST ride on the system prompt, so we carry it in
 * `providerOptions` on this instructions object. Harmless for non-Anthropic
 * models (`providerOptions` is namespaced).
 *
 * ai@7 prepends `instructions` to the model prompt as a `{ role:"system",
 * content, providerOptions }` message (`convertToLanguageModelPrompt`) — the
 * exact model input the old head-of-`messages` pattern produced, cacheControl
 * preserved — so this is the trusted server-side channel with no need for the
 * `allowSystemInMessages` compat flag. A bare string `instructions` would drop
 * the `providerOptions`, losing the cacheControl breakpoint; keep the object
 * form.
 */
export function aiSdkCachedSystemMessage(content: string) {
  return {
    role: "system" as const,
    content,
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } },
  };
}

/**
 * Per-step system trailer: everything that VARIES between steps, kept in its own
 * system block so it can never invalidate the cached prefix.
 *
 * ai@7 accepts `instructions` as an ARRAY of system messages and prepends them
 * in order, and the Anthropic provider maps them to consecutive `system` text
 * blocks carrying each message's own `cache_control`. So `[cached(system),
 * trailer]` puts the varying text strictly AFTER the breakpoint: the cached
 * prefix (the several-KB operation index) is byte-identical every step and still
 * hits, while the trailer is re-read uncached for a few dozen tokens.
 */
function aiSdkStepTrailerMessage(content: string) {
  return { role: "system" as const, content };
}

export function prepareAiSdkChatStep({
  stepNumber,
  system,
  modelMessages,
  markToolStepBudgetReached,
  turnDeadlineAt,
  now = Date.now(),
}: {
  stepNumber: number;
  system: string;
  modelMessages: ConvertedModelMessages;
  markToolStepBudgetReached: () => void;
  /** Absolute instant the turn ends — the model is shown what is left of it. */
  turnDeadlineAt: number;
  /** Clock seam (tests pin it). */
  now?: number;
}) {
  // A5: the model sees its own budget on EVERY step. Without it, it cannot
  // arbitrate — the audited turn launched a ~2-minute compilation with 22 s
  // left.
  const budgetNote = formatTurnBudgetNote({
    remainingMs: turnDeadlineAt - now,
    stepsUsed: stepNumber,
    maxSteps: CHAT_MAX_STEPS,
  });

  if (!isFinalChatStep(stepNumber, CHAT_MAX_STEPS)) {
    return {
      instructions: [aiSdkCachedSystemMessage(system), aiSdkStepTrailerMessage(budgetNote)],
    };
  }

  markToolStepBudgetReached();
  // Final step: the tool-less closing call. The final-step directive joins the
  // budget note in the trailer block rather than being concatenated into the
  // cached base — same model input, but the cache breakpoint now sits on the
  // unchanged base prompt instead of a per-step variant. `messages` is reset to
  // the original history (as before).
  return {
    activeTools: [],
    toolChoice: "none" as const,
    instructions: [
      aiSdkCachedSystemMessage(system),
      aiSdkStepTrailerMessage(`${budgetNote}\n\n${CHAT_FINAL_STEP_SYSTEM_PROMPT}`),
    ],
    messages: modelMessages,
  };
}

/**
 * TTL for the subscription-engine path's loopback bearer. The Pi chat engine
 * opens its platform MCP client once per turn with these headers, so the token
 * must outlive the whole turn (up to CHAT_MAX_STEPS steps, each able to
 * long-poll a run's status for ~55 s). 30 min is a generous ceiling for a
 * single interactive turn.
 */
const ENGINE_LOOPBACK_TTL_MS = 30 * 60_000;

// The client (assistant-ui / useChat) posts the full thread plus optional
// session/model/context extras. `messages` are UIMessages; we keep validation
// loose here and let `convertToModelMessages` enforce the real shape — with one
// tightening: any `file` part MUST reference an `upload://` or `document://`
// URI. That rejects inline `data:` bytes and arbitrary URLs in the chat channel
// (attachments flow only through the document store, never inline).
export const chatStreamSchema = z.object({
  id: z.string().optional(),
  messages: z
    .array(z.unknown())
    .min(1, "messages must not be empty")
    .superRefine((messages, ctx) => {
      messages.forEach((message, i) => {
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
              message: "File attachment URI must be an 'upload://' or 'document://' URI.",
              path: [i, "parts", j, "url"],
            });
          }
        });
      });
    }),
  modelId: z.string().optional(),
});

/** Truncated JSON preview for debug logs (keeps lines readable). */
function preview(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (!s) return "";
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/**
 * Message surfaced to the user when a turn fails (the AI SDK masks errors by
 * default). We pass the provider's own error through — typically the real
 * cause (e.g. a provider key misconfigured in the org's models).
 */
function clientErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const trimmed = msg.trim();
  if (!trimmed)
    return "Le modèle a échoué (erreur inconnue). Vérifiez la configuration des modèles de l'organisation.";
  return `Le modèle a échoué : ${trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed}`;
}

/** An armed turn ceiling: how the turn aborted, and how to cancel the timer. */
export interface ArmedTurnDeadline {
  /**
   * The turn's abort reason. Read this instead of `signal.reason`.
   *
   * UPSTREAM BUG, already fixed — oven-sh/bun#34636, fixed by oven-sh/bun#32747
   * ("AbortSignal: emit write barrier when storing abort reason", commit
   * b4e9605). `AbortSignal::markAborted` stored the reason without a GC write
   * barrier, so a concurrent collector that had already scanned the signal
   * wrapper could collect the reason while the signal itself stayed alive:
   * `signal.aborted` true, `signal.reason` `undefined`.
   *
   * Reproduced here on Bun 1.3.11 with a plain synchronous
   * `controller.abort(new Error(…))` — it is NOT specific to timers or to forced
   * GC, the trigger is simply that nothing else holds the object. Node keeps it
   * in every case. A collected reason would silently downgrade the ceiling to an
   * untagged stop — exactly the silent ending this path exists to prevent.
   *
   * The fix landed after v1.3.14, so it is not in the version this repo pins.
   * REMOVE THIS ACCESSOR (and read `signal.reason` directly) once the toolchain
   * moves past the first release containing #32747.
   */
  abortReason(): unknown;
  /** Cancel the timer. MUST be called on every exit path of the turn. */
  disarm(): void;
}

/**
 * Arm a turn's wall-clock ceiling on an existing abort controller.
 *
 * The abort reason is TAGGED ({@link ChatTurnDeadlineError}) so the finish path
 * can tell a ceiling apart from an explicit user stop. An armed timer that
 * outlived its turn would abort a controller that no longer belongs to anything
 * and keep the process awake for the rest of the ceiling — hence {@link
 * ArmedTurnDeadline.disarm}.
 */
export function armTurnDeadline(
  controller: AbortController,
  deadlineAt: number,
  deadlineMs: number = CHAT_TURN_DEADLINE_MS,
): ArmedTurnDeadline {
  const deadlineReason = new ChatTurnDeadlineError(deadlineMs);
  let fired = false;
  const timer = setTimeout(
    () => {
      fired = true;
      controller.abort(deadlineReason);
    },
    Math.max(0, deadlineAt - Date.now()),
  );
  return {
    abortReason: () => (fired ? deadlineReason : controller.signal.reason),
    disarm: () => clearTimeout(timer),
  };
}

/**
 * Closes a deadline-killed ai-sdk turn the way the Pi engine closes one.
 *
 * The ceiling is enforced by aborting the turn's `generation` controller, and
 * ai@7 answers an abort by emitting an `abort` chunk and closing the stream —
 * it publishes NO `finish` part, so `messageMetadata` is never invoked and the
 * turn would otherwise end with neither an explanation nor any metadata. That
 * is the audited failure mode: an assistant message with ZERO parts.
 *
 * This passthrough sits between `toUIMessageStream()` and the writer, so the
 * appended chunks are ordered in-band (a `flush` runs after the source closes
 * and before the merged stream ends). It writes:
 *
 *  - a REAL text part (`turnNoticeChunks`) — an `error` chunk is transient and
 *    never becomes a persisted message part, so it is invisible on reload;
 *  - the `finish` chunk the SDK skipped, carrying `finishReason: "deadline"`.
 *
 * The precedence rule is NOT re-derived here: {@link resolveTurnClosure} owns
 * it, so a genuine engine error still wins over the deadline.
 */
export function createTurnClosureStream(options: {
  /** The turn's generation signal — aborted by the deadline timer or an explicit stop. */
  signal: AbortSignal;
  /**
   * Why the turn aborted. Supplied rather than read off `signal.reason` — see
   * {@link ArmedTurnDeadline.abortReason}. Defaults to `signal.reason`.
   */
  abortReason?: () => unknown;
  /** Turn metadata for the synthesized `finish` chunk (same builder as the nominal path). */
  buildMetadata: (finishReason: ChatTurnFinishReason) => ChatMessageMetadata;
  /** Ceiling quoted to the user. Defaults to the shared turn deadline. */
  deadlineMs?: number;
  /** Notice part id (tests pin it). */
  newId?: () => string;
  /** Observability seam — called once when the deadline actually closed the turn. */
  onDeadline?: () => void;
}): TransformStream<UIMessageChunk, UIMessageChunk> {
  const deadlineMs = options.deadlineMs ?? CHAT_TURN_DEADLINE_MS;
  const newId = options.newId ?? (() => crypto.randomUUID());
  // A turn that published its own `finish` closed on its own terms; an abort
  // racing in just after it must not overwrite that ending with a truncation
  // notice for work that in fact completed.
  let sawFinish = false;
  let sawError = false;
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (chunk.type === "finish") sawFinish = true;
      if (chunk.type === "error") sawError = true;
      controller.enqueue(chunk);
    },
    flush(controller) {
      const closure = resolveTurnClosure({
        aborted: !sawFinish && options.signal.aborted,
        abortReason: options.abortReason ? options.abortReason() : options.signal.reason,
        // An aborted stream publishes no finish part, so the only finish reason
        // observable at this point is the failure the SDK streamed inline.
        finishReason: sawError ? "error" : "unknown",
      });
      if (!closure.deadlineReached) return;
      options.onDeadline?.();
      for (const chunk of turnNoticeChunks(newId(), turnDeadlineNoticeText(deadlineMs))) {
        controller.enqueue(chunk);
      }
      controller.enqueue({
        type: "finish",
        messageMetadata: options.buildMetadata(closure.finishReason),
      });
    },
  });
}

export async function handleChatStream(
  c: Context<ChatEnv>,
  deps: ChatPlatformDeps,
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
  // fetch when not wired) for every read the turn makes (/api/models,
  // /api/applications, /api/me/context, the llm-proxy). Auth + RBAC run each hop.
  const platformFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    deps.dispatch(new Request(input, init))) as typeof fetch;

  // Per-turn observability: structured per-step logs to stdout. Full payloads
  // only under CHAT_DEBUG — they may carry PII/customer content.
  const debug = Boolean(process.env.CHAT_DEBUG);
  const turnStart = Date.now();
  // The turn's TIME budget, as an absolute instant. Both engines share the
  // ceiling (`CHAT_TURN_DEADLINE_MS`): the Pi engine also enforces it as a hard
  // abort, and on both paths every `run_and_wait` derives its wait budget from
  // it instead of silently taking the 30-minute client default.
  const turnDeadlineAt = turnStart + CHAT_TURN_DEADLINE_MS;
  let completedSteps = 0;
  let stepStart = turnStart;
  let firstChunkAt = 0;
  let lastToolName: string | undefined;
  let toolStepBudgetReached = false;
  let aiSdkFinishReason: FinishReason | "unknown" = "unknown";

  // The proxy surfaces are bearer-only (cookies refused — CSRF model):
  // inference loopback calls carry a short-lived token only this process
  // can mint, scoped to llm-proxy:call + models:read. The MCP session keeps
  // the caller's own credentials (full RBAC fidelity on tool calls).
  //
  // The token lives 60 s, but a turn fans out into many inference calls over
  // up to CHAT_MAX_STEPS steps (with a run long-poll blocking for ~55s between
  // them), so we hand modelFromFamily a *minter* — the provider re-mints a fresh
  // bearer on every proxy call. The static header below is for the one-shot
  // calls (listModels) that fire immediately on this same line.
  const mintInferenceAuth = () =>
    mintLoopbackToken(
      { userId: user.id, email: user.email, name: user.name, orgId, orgRole },
      // The session id rides the SIGNED loopback claims (not a header) so the
      // llm-proxy can attribute the ai-sdk path's usage to the chat session
      // without trusting anything spoofable.
      { chatSessionId: meteringSessionId },
    );
  const inferenceHeaders: Record<string, string> = {
    Authorization: `Bearer ${mintInferenceAuth()}`,
    "X-Org-Id": orgId,
  };

  // ── Preamble phase A (parallel) ──────────────────────────────────────────
  // The model list and the default application id are independent reads, so
  // fire them together rather than back-to-back. `listModels` decides the
  // engine (we read the chosen row's providerId); the app id scopes the MCP
  // + integration reads that follow. Pin from the header when the caller
  // already supplied one (no lookup needed).
  const modelId = c.req.header("X-Model-Id") ?? body.modelId;
  const pinnedAppId = c.req.header("x-application-id");
  const phaseAStart = Date.now();
  const [models, applicationId] = await Promise.all([
    listModels(origin, inferenceHeaders, platformFetch),
    pinnedAppId
      ? Promise.resolve(pinnedAppId)
      : resolveDefaultApplicationId(origin, headers, orgId, platformFetch),
  ]);
  const chosen = pickModel(models, modelId);
  const phaseAMs = Date.now() - phaseAStart;
  logger.info("model resolved", {
    model: chosen.id,
    modelId: chosen.modelId,
    providerId: chosen.providerId,
  });

  // Materialize the new turn's composer attachments into durable, session-scoped
  // documents and rewrite each `upload://` (or already-`document://`) file part
  // to its stable `document://` URI, BEFORE the turn is persisted (persistence
  // stores only `document://`) and before it reaches either engine (the model is
  // shown the attachment as a text line, never a raw file URL). Needs the session
  // (the document container) and the resolved application id, both known here;
  // nothing has been opened yet, so a quota/cap rejection surfaces as a clean
  // error with no MCP/stop-controller to leak. Only the last message can carry
  // fresh uploads — earlier turns already hold rewritten `document://` URIs.
  if (sessionId && lastMessage && applicationId) {
    lastMessage = await materializeUserAttachments(lastMessage, (uri) =>
      deps.resolveChatAttachment({
        orgId,
        applicationId,
        userId: user.id,
        chatSessionId: sessionId,
        uri,
      }),
    );
    messages[messages.length - 1] = lastMessage;
  }

  // Subscription chat routing. Every oauth-subscription provider (claude-code,
  // codex) is served by ONE generic in-process Pi engine owned by this module —
  // there is no per-provider vendor-SDK seam. The platform resolves the chosen
  // model row: an API-key/unknown provider → `{ subscription: false }` (the
  // generic ai-sdk path below); an oauth2 provider → the real upstream binding +
  // a fresh access token (or a reconnect signal). Token resolution (decrypt +
  // possible refresh) happens here in the preamble, alongside the other reads.
  const subscription = await deps.resolveSubscriptionChatModel(orgId, chosen.id);
  const isSubscription = subscription.subscription;

  // Admission gate — EVERY turn, whichever engine serves it. The platform
  // resolves system-provided vs. org-owned server-side and dispatches
  // `beforeUsage` (chat context) with that fact; a metering module quotes it and
  // decides.
  //
  // A subscription turn used to skip this entirely, on the reasoning that it
  // spends the user's OWN credential (`credentialSource` `org`) and therefore
  // costs nothing. That is the module's call to make, not the platform's: the
  // turn is driven by the IN-PROCESS Pi engine, so the platform funds its
  // compute even when it funds no inference, and a module gating on
  // subscription status must be able to refuse it. We report
  // `subscription: true` — the one fact this module owns, since it picked the
  // engine — and the platform derives the credential source from it.
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

  // ── Preamble phase B (parallel) ──────────────────────────────────────────
  // The caller-context block (both paths) and the platform MCP probe (ai-sdk
  // path only) are independent — run them together.
  //
  // The subscription path SKIPS the probe entirely: the Pi chat engine opens
  // its OWN MCP connection from `platformMcp.url`, and the MCP server's
  // instructions reach the model through that handshake. A probe here would be
  // a second handshake we'd immediately close (2 round-trips wasted on the
  // TTFT path). We pass `platformMcp` optimistically; if the `mcp` module is
  // absent the engine just gets no tools.
  let mcp: Awaited<ReturnType<typeof openPlatformMcp>> | null = null;
  // Single MCP-teardown path. The session must be closed on EVERY ai-sdk exit
  // (stream `onError` AND `onEnd`, and a mid-stream client disconnect) or it
  // leaks per turn — close failures are swallowed (warn only) so they never mask
  // the turn result. `await` it on the synchronous paths, `void` in callbacks.
  const closeMcp = async (): Promise<void> => {
    try {
      await mcp?.close();
    } catch (err) {
      logger.warn("mcp close failed", { err: String(err) });
    }
  };

  const phaseBStart = Date.now();
  const contextPromise = buildCallerContextBlock(c, {
    origin,
    headers,
    applicationId,
    user,
    deps,
    // UI language forwarded by the client; validated/defaulted in the builder.
    locale: c.req.header("X-Chat-Locale"),
  });
  let contextBlock: string;
  if (isSubscription) {
    contextBlock = await contextPromise;
  } else {
    // The chat's tools come from the platform MCP module (`/api/mcp/o/:org`).
    // `mcp` is a hard peer requirement (declared in the chat manifest, enforced
    // at boot), so a failure to open it here is a genuine misconfiguration —
    // let it propagate to a 5xx rather than silently degrading to a no-tools
    // chat.
    const [openedMcp, block] = await Promise.all([
      openPlatformMcp({
        origin,
        headers,
        orgId,
        applicationId,
        fetch: platformFetch,
        turnDeadlineAt,
        chatSessionId: meteringSessionId,
      }),
      contextPromise,
    ]);
    mcp = openedMcp;
    contextBlock = block;
  }
  const phaseBMs = Date.now() - phaseBStart;

  // Assemble the system prompt. Subscription path: tool-grounding prompt, no
  // inline instructions (the SDK's own MCP handshake delivers them). ai-sdk
  // path: prompt + the platform MCP server instructions (mcp is required, so
  // it's always present here).
  let system = isSubscription
    ? SYSTEM_PROMPT
    : mcp?.instructions
      ? `${SYSTEM_PROMPT}\n\n${mcp.instructions}`
      : SYSTEM_PROMPT;
  if (contextBlock) system += `\n\n${contextBlock}`;
  system = applyOperationIndexPolicy(system, chosen.apiShape);

  logger.info("chat preamble", {
    engine: isSubscription ? "subscription" : "ai-sdk",
    providerId: chosen.providerId,
    phaseAMs,
    phaseBMs,
    preambleMs: Date.now() - turnStart,
    hasTools: isSubscription || Boolean(mcp),
  });

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
      // The MCP session was opened during the preamble (ai-sdk path) but
      // generation has not started, so neither `finalize` (teardown via
      // onSettled) nor `failCleanup` (defined below) owns it yet. If the user
      // -message persist or the active-stream marker throws here, the session
      // would leak per failed turn. Close it on this error path before
      // rethrowing. Credential headers are untouched — this is purely the
      // leak-on-error cleanup.
      await closeMcp();
      throw err;
    }
  }

  // Generation abort is DECOUPLED from the request connection: a client
  // disconnect must NOT cancel generation (that was the data-loss bug). Only an
  // explicit stop (POST /api/chat/sessions/:id/stop) aborts this controller.
  const generation = new AbortController();
  registerStopController(streamId, generation);

  // The turn's wall-clock ceiling, ARMED (the ai-sdk path arms it just before
  // `streamText`; the Pi engine owns its own timer). `turnDeadlineAt` was
  // already handed to every child call as their budget — without a timer here
  // nothing would end the turn at that instant, so a `run_and_wait` refused for
  // being past the deadline had no turn-ending event to follow it: the run kept
  // going with nowhere to be announced, and every remaining step answered
  // "relaunch next turn" forever. The abort is TAGGED so the finish path can
  // tell it apart from an explicit stop (see `resolveTurnClosure`).
  let armedDeadline: ArmedTurnDeadline | undefined;
  const clearDeadline = (): void => {
    armedDeadline?.disarm();
  };

  // Tee the engine stream into a resumable producer (decoupled from the client)
  // and persist the assistant turn when it finalizes — both run to completion
  // regardless of the client; the persist task is tracked for graceful shutdown.
  // See finalize-stream.ts for the disconnect-survival guarantee + its test.
  const finalize = (engineResponse: Response): Promise<Response> =>
    finalizeChatStream({
      engineResponse,
      streamId,
      parentId: userMessageId ?? null,
      onAssistant:
        sessionId && userMessageId
          ? (assistant, parentId) => persistAssistantMessage(sessionId, assistant, parentId)
          : undefined,
      onSettled: () => {
        clearDeadline();
        unregisterStopController(streamId);
        // Fire-and-forget teardown — swallow rejections so a failed DB update or
        // MCP close can't surface as an unhandled rejection.
        if (sessionId) void clearActiveStream(sessionId, streamId).catch(() => {});
        void closeMcp();
      },
    });

  // Teardown for the failure paths below: if generation throws BEFORE `finalize`
  // takes over (which owns teardown via `onSettled`), we must still release the
  // stop controller, clear the in-flight marker (else the session is stuck
  // "generating" with a dead stream id), and close MCP.
  const failCleanup = async () => {
    clearDeadline();
    unregisterStopController(streamId);
    if (sessionId) await clearActiveStream(sessionId, streamId).catch(() => {});
    await closeMcp();
  };

  // Subscription path — the generic in-process Pi engine drives the turn with
  // the real access token resolved above; the token stays in this process's
  // memory (in-memory AuthStorage, never persisted, never sent to the client).
  if (subscription.subscription) {
    if ("needsReconnection" in subscription) {
      // The oauth credential is dead → tell the client to reconnect rather than
      // launching a session that would 401 upstream.
      await failCleanup();
      return subscriptionReconnectResponse();
    }
    // The Pi session opens its OWN platform MCP connection (`/api/mcp/o/:org`),
    // and run_and_wait hits platform run routes with these headers. It must NEVER
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
    if (applicationId) mcpHeaders["x-application-id"] = applicationId;
    try {
      return await finalize(
        runPiSubscriptionChat({
          model: subscription.model,
          presetId: chosen.id,
          orgId,
          userId: user.id,
          chatSessionId: meteringSessionId,
          prompt: buildTranscriptPrompt(messages),
          system,
          platformMcp: { url: platformMcpUrl(origin, orgId), headers: mcpHeaders },
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

  // ai-sdk path — API-key providers only, bound to the llm-proxy.
  const model = modelFromFamily(chosen, origin, inferenceHeaders, mintInferenceAuth, platformFetch);
  if (!model) {
    await failCleanup();
    throw invalidRequest(`Model family "${chosen.apiShape}" is not supported by the chat.`);
  }

  try {
    // Flatten file attachments to model-facing text lines first (a `document://`
    // URL is not a fetchable data URL — passing the raw file part would break the
    // provider), then pass the tools so replayed tool results go through each
    // tool's `toModelOutput` — the connect-link redaction must hold on history
    // replay too, not just on the turn that produced the result.
    const modelMessages = await convertToModelMessages(messagesWithAttachmentsAsText(messages), {
      tools: mcp ? mcp.tools : undefined,
    });

    // Arm the ceiling. Only on this path: the Pi engine owns (and clears) its
    // own timer, so arming here too would double it. Cleared by `clearDeadline`
    // on every exit — `finalize`'s `onSettled` on the nominal path, `failCleanup`
    // on the failure paths — so it never outlives the turn.
    const turnDeadline = armTurnDeadline(generation, turnDeadlineAt);
    armedDeadline = turnDeadline;

    const result = streamText({
      model,
      // System rides via the canonical `instructions` field as a cache-controlled
      // `SystemModelMessage`; ai@7 prepends it to the model prompt as a system
      // message (cacheControl preserved). See `aiSdkCachedSystemMessage` for why
      // the object form (not a bare string) is required and why `prepareStep`
      // overrides `instructions` per-step on the final step.
      instructions: aiSdkCachedSystemMessage(system),
      messages: modelMessages,
      tools: mcp ? mcp.tools : undefined,
      stopWhen: isStepCount(CHAT_MAX_STEPS),
      prepareStep: ({ stepNumber }) =>
        prepareAiSdkChatStep({
          stepNumber,
          system,
          modelMessages,
          markToolStepBudgetReached: () => {
            toolStepBudgetReached = true;
          },
          turnDeadlineAt,
        }),
      // Decoupled from the request connection (see `generation` above): a client
      // disconnect must not cancel generation; only an explicit stop does.
      abortSignal: generation.signal,
      onChunk: ({ chunk }) => {
        // TTFT marker: log once on the first model output (text or tool call),
        // measured from turn start. The dominant lever this work optimizes.
        if (firstChunkAt === 0 && (chunk.type === "text-delta" || chunk.type === "tool-call")) {
          firstChunkAt = Date.now();
          logger.info("chat first token", { firstTokenMs: firstChunkAt - turnStart });
        }
      },
      onStepEnd: ({ toolCalls, toolResults, finishReason, usage }) => {
        const now = Date.now();
        const step = completedSteps;
        completedSteps += 1;
        const toolName = toolCalls.at(-1)?.toolName;
        if (toolName) lastToolName = toolName;
        // `usage` here is this step's own token count (StepResult.usage).
        logger.info("chat step", {
          step,
          finishReason,
          usage,
          stepMs: now - stepStart,
          tools: toolCalls.map((t) => t.toolName),
          ...(debug
            ? {
                toolCalls: toolCalls.map((t) => ({ tool: t.toolName, input: preview(t.input) })),
                toolResults: toolResults.map((t) => ({
                  tool: t.toolName,
                  output: preview(t.output),
                })),
              }
            : {}),
        });
        stepStart = now;
      },
      onError: ({ error }) => {
        // MCP teardown is owned by `finalize` (its persist `finally`), which runs
        // to completion regardless of the client — so it is not closed here.
        logger.error("chat stream error", { err: String(error) });
      },
      onEnd: ({ usage, finishReason }) => {
        aiSdkFinishReason = finishReason ?? "unknown";
        // v7's `onEnd.usage` is the cumulative usage across all steps — the same
        // semantics v6 exposed as `totalUsage` (which is now a deprecated alias).
        logger.info("chat turn done", {
          steps: completedSteps,
          totalMs: Date.now() - turnStart,
          usage,
          finishReason,
        });
      },
    });

    // ONE metadata builder for both the nominal `finish` part and the one the
    // closure stream synthesizes when the deadline fired (ai@7 publishes no
    // `finish` on an abort) — so a deadline-killed turn reports the same step
    // counters as any other, with `finishReason: "deadline"`.
    const buildTurnMetadata = (finishReason: ChatTurnFinishReason): ChatMessageMetadata =>
      mergeTurnMetadata(undefined, {
        engine: "ai-sdk",
        finishReason,
        stepCount: completedSteps,
        maxSteps: CHAT_MAX_STEPS,
        toolStepBudget: CHAT_TOOL_STEP_BUDGET,
        toolStepBudgetReached,
        maxStepsReached: completedSteps >= CHAT_MAX_STEPS,
        ...(lastToolName ? { lastToolName } : {}),
      });

    // NOTE: no client-disconnect → closeMcp listener. Generation now outlives the
    // connection (resumable producer), so MCP must stay open until the stream
    // finalizes; `finalize` closes it once persistence completes.
    //
    // The result no longer goes straight to `toUIMessageStreamResponse`: it is
    // merged into a `createUIMessageStream` so the deadline notice can be
    // appended as a REAL text part. `toUIMessageStreamResponse` is exactly
    // `createUIMessageStreamResponse({ stream: toUIMessageStream(...) })`, so
    // the nominal wire output is unchanged.
    const uiStream = createUIMessageStream({
      onError: clientErrorMessage,
      execute: ({ writer }) => {
        writer.merge(
          result
            .toUIMessageStream({
              // Surface the real failure to the client (AI SDK masks errors otherwise).
              onError: clientErrorMessage,
              // Emit a real assistant message id in the stream so the client and the
              // server-side persist agree on it (and never collide on an empty id).
              generateMessageId: () => crypto.randomUUID(),
              messageMetadata: ({ part }) =>
                part.type === "finish"
                  ? buildTurnMetadata(part.finishReason ?? aiSdkFinishReason)
                  : undefined,
            })
            .pipeThrough(
              createTurnClosureStream({
                signal: generation.signal,
                abortReason: () => turnDeadline.abortReason(),
                buildMetadata: buildTurnMetadata,
                onDeadline: () =>
                  logger.warn("chat turn deadline reached", {
                    chatSessionId: meteringSessionId,
                    steps: completedSteps,
                    deadlineMs: CHAT_TURN_DEADLINE_MS,
                  }),
              }),
            ),
        );
      },
    });
    return await finalize(createUIMessageStreamResponse({ stream: uiStream }));
  } catch (err) {
    await failCleanup();
    throw err;
  }
}
