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
  stepCountIs,
  type FinishReason,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { parseBody, invalidRequest } from "@appstrate/core/api-errors";
import { logger } from "./logger.ts";
import { applyOperationIndexPolicy } from "./operation-index.ts";
export { applyOperationIndexPolicy } from "./operation-index.ts";
import { listModels, pickModel, modelFromFamily, resolveDefaultApplicationId } from "./llm.ts";
import { openPlatformMcp, platformMcpUrl } from "./platform-mcp.ts";
import { selfOrigin, forwardedHeaders } from "./self.ts";
import { mintLoopbackToken, mintMcpLoopbackToken } from "./loopback-auth.ts";
import { buildTranscriptPrompt } from "./transcript.ts";
import { runPiSubscriptionChat } from "./pi-chat/engine.ts";
import { SYSTEM_PROMPT, buildCallerContextBlock, type ChatEnv } from "./prompt.ts";
export type { ChatEnv } from "./prompt.ts";
import { finalizeChatStream } from "./finalize-stream.ts";
import { ensureSession, persistUserMessage, persistAssistantMessage } from "./persistence.ts";
import { registerStopController, unregisterStopController } from "./stop-registry.ts";
import { setActiveStream, clearActiveStream } from "./resumable.ts";
import type { ChatPlatformDeps } from "./platform-services.ts";
import {
  appendFinalStepSystemPrompt,
  CHAT_MAX_STEPS,
  CHAT_TOOL_STEP_BUDGET,
  isFinalChatStep,
  mergeTurnMetadata,
  type AppstrateTurnMetadata,
} from "@appstrate/core/chat-turn-metadata";

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

type ConvertedModelMessages = Awaited<ReturnType<typeof convertToModelMessages>>;

export function aiSdkCachedSystemMessage(content: string) {
  return {
    role: "system" as const,
    content,
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } },
  };
}

export function prepareAiSdkChatStep({
  stepNumber,
  system,
  modelMessages,
  markToolStepBudgetReached,
}: {
  stepNumber: number;
  system: string;
  modelMessages: ConvertedModelMessages;
  markToolStepBudgetReached: () => void;
}) {
  if (!isFinalChatStep(stepNumber, CHAT_MAX_STEPS)) return undefined;
  markToolStepBudgetReached();
  return {
    activeTools: [],
    toolChoice: "none" as const,
    messages: [aiSdkCachedSystemMessage(appendFinalStepSystemPrompt(system)), ...modelMessages],
  };
}

/**
 * TTL for the engine path's loopback bearer. The Agent SDK bakes it into the
 * spawned binary's env once, so it must outlive the whole turn (up to
 * CHAT_MAX_STEPS turns, each able to long-poll a run's status for ~55 s). 30
 * min is a generous ceiling for a single interactive turn.
 */
const ENGINE_LOOPBACK_TTL_MS = 30 * 60_000;

// The client (assistant-ui / useChat) posts the full thread plus optional
// session/model/context extras. `messages` are UIMessages; we keep validation
// loose here and let `convertToModelMessages` enforce the real shape.
const chatStreamSchema = z.object({
  id: z.string().optional(),
  messages: z.array(z.unknown()).min(1, "messages must not be empty"),
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
  const lastMessage = messages[messages.length - 1] as UIMessage | undefined;

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
    mintLoopbackToken({ userId: user.id, email: user.email, name: user.name, orgId, orgRole });
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
    // metadata_only (skip credential decrypt) is safe only when an explicit
    // model is pinned — that id came from the filtered picker, so it's reachable.
    // Without a pin we resolve the org default from the full filtered list, so a
    // dead-credential default is dropped rather than picked → inference error.
    listModels(origin, inferenceHeaders, platformFetch, { metadataOnly: Boolean(modelId) }),
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

  // Subscription chat routing. Every oauth-subscription provider (claude-code,
  // codex) is served by ONE generic in-process Pi engine owned by this module —
  // there is no per-provider vendor-SDK seam. The platform resolves the chosen
  // model row: an API-key/unknown provider → `{ subscription: false }` (the
  // generic ai-sdk path below); an oauth2 provider → the real upstream binding +
  // a fresh access token (or a reconnect signal). Token resolution (decrypt +
  // possible refresh) happens here in the preamble, alongside the other reads.
  const subscription = await deps.resolveSubscriptionChatModel(orgId, chosen.id);
  const isSubscription = subscription.subscription;

  // ── Preamble phase B (parallel) ──────────────────────────────────────────
  // The caller-context block (both paths) and the platform MCP probe (ai-sdk
  // path only) are independent — run them together.
  //
  // The subscription (claude-code) path SKIPS the probe entirely: the official
  // binary opens its OWN MCP connection from `platformMcp.url`, and the MCP
  // server's instructions reach the model through that handshake. A probe here
  // would be a second handshake we'd immediately close (2 round-trips wasted on
  // the TTFT path). We pass `platformMcp` optimistically; if the `mcp` module is
  // absent the SDK just gets no tools.
  let mcp: Awaited<ReturnType<typeof openPlatformMcp>> | null = null;
  // Single MCP-teardown path. The session must be closed on EVERY ai-sdk exit
  // (stream `onError` AND `onFinish`, and a mid-stream client disconnect) or it
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
      openPlatformMcp({ origin, headers, orgId, applicationId, fetch: platformFetch }),
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
    // Pass the tools so replayed tool results go through each tool's
    // `toModelOutput` — the connect-link redaction must hold on history
    // replay too, not just on the turn that produced the result.
    const modelMessages = await convertToModelMessages(messages, {
      tools: mcp ? mcp.tools : undefined,
    });
    const result = streamText({
      model,
      // System rides as a cached message part rather than the `system` field:
      // the platform MCP instructions now carry a generated operation index
      // (several KB, re-sent on every one of the up-to-CHAT_MAX_STEPS inference
      // calls in a turn). OpenAI auto-caches the prefix and the Claude Agent
      // SDK path caches on its own; the ai-sdk Anthropic providers need an
      // explicit cache_control breakpoint or they'd pay the index in full each
      // step. Harmless for non-Anthropic models (providerOptions is namespaced).
      messages: [aiSdkCachedSystemMessage(system), ...modelMessages],
      tools: mcp ? mcp.tools : undefined,
      stopWhen: stepCountIs(CHAT_MAX_STEPS),
      prepareStep: ({ stepNumber }) =>
        prepareAiSdkChatStep({
          stepNumber,
          system,
          modelMessages,
          markToolStepBudgetReached: () => {
            toolStepBudgetReached = true;
          },
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
      onStepFinish: ({ toolCalls, toolResults, finishReason, usage }) => {
        const now = Date.now();
        const step = completedSteps;
        completedSteps += 1;
        const toolName = toolCalls.at(-1)?.toolName;
        if (toolName) lastToolName = toolName;
        logger.info("chat step", {
          step,
          finishReason,
          usage: usage as unknown as Record<string, unknown>,
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
      onFinish: ({ totalUsage, finishReason }) => {
        aiSdkFinishReason = finishReason ?? "unknown";
        logger.info("chat turn done", {
          steps: completedSteps,
          totalMs: Date.now() - turnStart,
          usage: totalUsage as unknown as Record<string, unknown>,
          finishReason,
        });
      },
    });

    // NOTE: no client-disconnect → closeMcp listener. Generation now outlives the
    // connection (resumable producer), so MCP must stay open until the stream
    // finalizes; `finalize` closes it once persistence completes.
    // Surface the real failure to the client (AI SDK masks errors otherwise).
    return await finalize(
      result.toUIMessageStreamResponse({
        onError: clientErrorMessage,
        // Emit a real assistant message id in the stream so the client and the
        // server-side persist agree on it (and never collide on an empty id).
        generateMessageId: () => crypto.randomUUID(),
        messageMetadata: ({ part }) => {
          if (part.type !== "finish") return undefined;
          const turn: AppstrateTurnMetadata = {
            engine: "ai-sdk",
            finishReason: part.finishReason ?? aiSdkFinishReason,
            stepCount: completedSteps,
            maxSteps: CHAT_MAX_STEPS,
            toolStepBudget: CHAT_TOOL_STEP_BUDGET,
            toolStepBudgetReached,
            maxStepsReached: completedSteps >= CHAT_MAX_STEPS,
            ...(lastToolName ? { lastToolName } : {}),
          };
          return mergeTurnMetadata(undefined, turn);
        },
      }),
    );
  } catch (err) {
    await failCleanup();
    throw err;
  }
}
