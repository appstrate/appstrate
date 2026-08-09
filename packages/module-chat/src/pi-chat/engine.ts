// SPDX-License-Identifier: Apache-2.0

/**
 * `runPiSubscriptionChat` — the SINGLE in-process chat engine for every
 * oauth-subscription provider (claude-code, codex).
 *
 * Runs a `@mariozechner/pi-coding-agent` session in the `apps/api` process,
 * driven by the Pi SDK (`@mariozechner/pi-ai`), which natively emits each
 * provider's subscription request shape from the real access token — the
 * Anthropic OAuth fingerprint (`sk-ant-oat…` → beta + claude-cli UA + system
 * prelude) or the codex-responses headers (`chatgpt-account-id` decoded from the
 * token JWT). The platform forges nothing; request-shape fidelity is delegated
 * to Pi. There is no per-provider chat engine or handler seam — every
 * subscription provider rides this one loop.
 *
 * The chat runs server-side, so the real subscription token is registered
 * directly in an in-memory {@link AuthStorage} (never persisted, never handed to
 * the client) — no sidecar/gateway bearer-swap is needed (that only exists for
 * containerised RUNS, where the token must stay out of the agent container).
 *
 * The Pi session's event stream is mapped onto the AI-SDK UI-message-stream
 * ({@link PiChatUiStreamMapper}), the exact protocol the chat client already
 * consumes from the ai-sdk path — one client contract, two loops.
 */

import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageChunk } from "ai";
import {
  loadPiCodingAgentSdk,
  derivePiCompactionSettings,
  prepareRequestedThinkingLevel,
} from "@appstrate/runner-pi";
import { CHAT_TOOL_STEP_BUDGET, CHAT_TURN_DEADLINE_MS } from "@appstrate/core/chat-turn-metadata";
import type { ChatUsageRecord } from "@appstrate/core/chat-contract";
import { applyOperationIndexPolicy } from "../operation-index.ts";
import { logger } from "../logger.ts";
import { PiChatUiStreamMapper } from "./ui-stream-mapper.ts";
import type { AgentSessionEvent } from "./pi-events.ts";
import { buildPlatformMcpTools } from "./mcp-tools.ts";
import { acquirePiChatSlot, chatCapacityResponse, releaseOnClose } from "./concurrency.ts";
import { createStepCapController, type PiChatSession } from "./turn-control.ts";
import {
  ChatTurnDeadlineError,
  resolveTurnClosure,
  turnDeadlineNoticeText,
  turnNoticeChunks,
} from "../turn-closure.ts";
import { classifyClientTurnError, clientTurnErrorMarker } from "../turn-error.ts";
import type { ModelGenerationSettings } from "@appstrate/core/model-generation";
import {
  buildSubscriptionTurnMetadata,
  subscriptionFailureChunks,
} from "./subscription-turn-closure.ts";
import type { ResolvedPiChatModelBinding } from "./model-binding.ts";

/**
 * Wall-clock ceiling for a single chat turn. A turn fans out into up to
 * CHAT_MAX_STEPS steps (each possibly long-polling a run for ~55 s), so the
 * budget is generous; it exists to stop a wedged upstream stream from holding a
 * concurrency slot forever.
 *
 * It now lives in `@appstrate/core/chat-turn-metadata` next to the step budget:
 * both engines derive their child-call budgets from the SAME ceiling, and a
 * `run_and_wait` can no longer be granted more time than the turn hosting it.
 */

export interface PiSubscriptionChatInput {
  /** Resolved Pi model, authentication transport and metering ownership. */
  modelBinding: ResolvedPiChatModelBinding;
  /** Appstrate preset id (org model row id) — stored as `llm_usage.model`. */
  presetId: string;
  orgId: string;
  userId: string;
  /** Chat session the turn belongs to (null for an ephemeral, unpersisted turn). */
  chatSessionId: string | null;
  /** Pre-assembled transcript prompt for this turn. */
  prompt: string;
  /** Base system persona (+ caller context) — MCP instructions are appended here. */
  system: string;
  generation: ModelGenerationSettings;
  /** Platform HTTP MCP server (meta-tools) — the engine opens its own client. */
  platformMcp: { url: string; headers: Record<string, string> };
  /** Aborts when the turn is explicitly stopped (decoupled from client disconnect). */
  abortSignal: AbortSignal;
  /** Maps a thrown error to a client-safe message. */
  onError: (error: unknown) => string;
  /** Persist one metered `llm_usage` row for the turn (fire-and-forget). */
  recordUsage: (record: ChatUsageRecord) => void;
}

/**
 * Drive one subscription chat turn and return the UI-message-stream `Response`.
 * Returns a 429 immediately when the in-process session cap is saturated.
 */
export function runPiSubscriptionChat(input: PiSubscriptionChatInput): Response {
  const slot = acquirePiChatSlot();
  if (!slot) return chatCapacityResponse();

  const { modelBinding, platformMcp, abortSignal, onError } = input;
  const model = modelBinding.model;
  const mapper = new PiChatUiStreamMapper();
  const startedAt = Date.now();

  const stream = createUIMessageStream({
    onError,
    execute: async ({ writer }) => {
      let streamStarted = false;
      let streamFinished = false;
      const write = (chunk: UIMessageChunk): void => {
        writer.write(chunk);
        if (chunk.type === "start") streamStarted = true;
        if (chunk.type === "finish") streamFinished = true;
      };

      // Deadline + explicit-stop → one combined abort threaded into the prompt.
      // The two causes are NOT interchangeable at the finish line (an explicit
      // stop is a normal ending; a deadline is a truncation the user must be
      // told about), so the deadline tags its abort reason — see
      // `resolveTurnClosure`.
      const turnAbort = new AbortController();
      const forwardAbort = (): void => turnAbort.abort(abortSignal.reason);
      if (abortSignal.aborted) turnAbort.abort(abortSignal.reason);
      else abortSignal.addEventListener("abort", forwardAbort, { once: true });
      // The ABSOLUTE instant this turn dies. The timer below is just its local
      // expression; the timestamp itself is what descends into every child call
      // (run_and_wait) so the whole subtree ends at the same instant.
      const turnDeadlineAt = startedAt + CHAT_TURN_DEADLINE_MS;
      const deadline = setTimeout(
        () => turnAbort.abort(new ChatTurnDeadlineError(CHAT_TURN_DEADLINE_MS)),
        Math.max(0, turnDeadlineAt - Date.now()),
      );

      // Inside the try so the deadline timer + abort listener above are torn
      // down even when construction fails (they'd otherwise survive until the
      // 10-minute deadline).
      let mcpTools: Awaited<ReturnType<typeof buildPlatformMcpTools>> | undefined;
      let stepCap: ReturnType<typeof createStepCapController> | undefined;
      try {
        // Platform meta-tools (search/describe/invoke_operation + run_and_wait).
        // A failure here is a genuine misconfiguration (the chat's value IS the
        // tools) — let it propagate to `onError`.
        mcpTools = await buildPlatformMcpTools({
          url: platformMcp.url,
          headers: platformMcp.headers,
          writeChunk: write,
          signal: turnAbort.signal,
          // Budget seam: the turn deadline bounds every run_and_wait, and the
          // live step count feeds the per-step budget note the model reads.
          turnBudget: {
            deadlineAt: turnDeadlineAt,
            stepCount: () => mapper.stepCount(),
            chatSessionId: input.chatSessionId,
            orgId: input.orgId,
          },
        });

        const {
          AuthStorage,
          createAgentSession,
          DefaultResourceLoader,
          ModelRegistry,
          SessionManager,
          SettingsManager,
        } = await loadPiCodingAgentSdk();

        const piModel = model;
        const requestedThinkingLevel = input.generation.reasoningLevel ?? "medium";
        const {
          model: sessionModel,
          thinkingLevel,
          thinkingBudgets,
        } = prepareRequestedThinkingLevel(piModel, requestedThinkingLevel);

        // OAuth uses the real access token in memory. Proxy-routed models use
        // only the inert `proxy` placeholder and replace the stream below.
        const authStorage = AuthStorage.inMemory();
        authStorage.setRuntimeApiKey(modelBinding.provider, modelBinding.runtimeApiKey);
        const modelRegistry = ModelRegistry.create(authStorage);

        // MCP server usage guidance is appended to the system prompt, then the
        // (uncacheable) operation index is dropped for providers without a
        // prompt cache — the same shared policy the ai-sdk path applies.
        let system = mcpTools.instructions
          ? `${input.system}\n\n${mcpTools.instructions}`
          : input.system;
        system = applyOperationIndexPolicy(system, model.api);

        const generationExtensions =
          input.generation.temperature === undefined
            ? []
            : [
                (pi: import("@appstrate/runner-pi").ExtensionAPI) => {
                  pi.on("before_provider_request", (event) => {
                    if (!event.payload || typeof event.payload !== "object") return undefined;
                    return { ...event.payload, temperature: input.generation.temperature };
                  });
                },
              ];
        const resourceLoader = new DefaultResourceLoader({
          cwd: "/tmp",
          agentDir: "/tmp/pi-chat",
          settingsManager: SettingsManager.inMemory(),
          extensionFactories: [...mcpTools.extensionFactories, ...generationExtensions],
          noExtensions: false,
          noPromptTemplates: true,
          noThemes: true,
          systemPrompt: system,
        });
        await resourceLoader.reload();

        const { session } = await createAgentSession({
          cwd: "/tmp",
          agentDir: "/tmp/pi-chat",
          model: sessionModel,
          thinkingLevel,
          authStorage,
          modelRegistry,
          resourceLoader,
          sessionManager: SessionManager.inMemory(),
          settingsManager: SettingsManager.inMemory({
            compaction: derivePiCompactionSettings(piModel).compaction,
            thinkingBudgets,
            // ONE retry: chat is interactive — a user watches blank "thinking"
            // dots for the whole retry window. One retry absorbs transient
            // blips; anything sturdier (quota 429s, auth failures) fails the
            // same way on every attempt and should surface fast. Runs keep
            // their own (more patient) retry policy.
            retry: { enabled: true, maxRetries: 1 },
          }),
          // Chat must NOT get the built-in host tools (read/bash/edit/write) —
          // only the platform MCP meta-tools (extension tools stay enabled).
          noTools: "builtin",
        });

        if (modelBinding.authMode === "proxy") {
          session.agent.streamFn = modelBinding.stream;
        }

        write(mapper.startChunk(crypto.randomUUID()));

        const typedSession = session as unknown as PiChatSession;

        // Enforce CHAT_MAX_STEPS on this engine too (it used to be reported and
        // never applied). The cap cuts the TOOL loop one step early and the
        // closing tool-less call below spends the last step on an answer.
        stepCap = createStepCapController({
          modelCallCount: () => mapper.stepCount(),
        });
        stepCap.attach(typedSession);

        typedSession.subscribe((raw) => {
          for (const chunk of mapper.map(raw as AgentSessionEvent)) write(chunk);
        });

        const abortPromise = new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(turnAbort.signal.reason ?? new Error("chat turn aborted"));
          if (turnAbort.signal.aborted) onAbort();
          else turnAbort.signal.addEventListener("abort", onAbort, { once: true });
        });

        try {
          await Promise.race([typedSession.prompt(input.prompt), abortPromise]);
          // Early-stopping generate: the tool loop was cut at
          // CHAT_TOOL_STEP_BUDGET, so spend the last step on ONE tool-less model
          // call — the user gets a synthesis of the work already done instead of
          // a truncated tool call. Same contract as the ai-sdk engine's final
          // step (`prepareAiSdkChatStep`).
          if (stepCap.fired()) {
            logger.info("chat turn step cap reached", {
              chatSessionId: input.chatSessionId,
              stepCount: mapper.stepCount(),
              toolStepBudget: CHAT_TOOL_STEP_BUDGET,
            });
            await Promise.race([stepCap.runFinalStep(typedSession), abortPromise]);
          }
        } catch (err) {
          // An explicit stop / deadline surfaces as an abort — end the turn
          // gracefully (the partial stream is already delivered) rather than
          // throwing into the client. A genuine engine error still flows to the
          // finish chunk via the mapper's captured stopReason.
          void typedSession.abort?.().catch(() => {});
          if (!turnAbort.signal.aborted) throw err;
        }

        // Invariant: an errored turn ALWAYS surfaces a visible error. Raw Pi /
        // provider text is classified before it crosses the stream or
        // persistence boundary; the client localizes the stable category.
        const meta = mapper.result();
        const rawError =
          meta.errorText ?? (meta.finishReason === "error" ? "unknown model error" : undefined);
        const clientError = rawError ? classifyClientTurnError(rawError) : undefined;
        if (clientError) write({ type: "error", errorText: clientTurnErrorMarker(clientError) });

        const stepCount = mapper.stepCount();
        const closure = resolveTurnClosure({
          aborted: turnAbort.signal.aborted,
          abortReason: turnAbort.signal.reason,
          finishReason: meta.finishReason,
        });
        // Same invariant, second failure mode: a turn killed by the deadline
        // used to end in complete silence. It gets a REAL text part — an
        // `error` chunk is transient and never becomes a persisted message part.
        if (closure.deadlineReached) {
          logger.warn("chat turn deadline reached", {
            chatSessionId: input.chatSessionId,
            stepCount,
            deadlineMs: CHAT_TURN_DEADLINE_MS,
          });
          const notice = turnNoticeChunks(
            crypto.randomUUID(),
            turnDeadlineNoticeText(CHAT_TURN_DEADLINE_MS),
          );
          for (const chunk of notice) write(chunk);
        }

        write({
          type: "finish",
          messageMetadata: buildSubscriptionTurnMetadata({
            finishReason: closure.finishReason,
            ...(clientError ? { clientError } : {}),
            stepCount,
            // Both flags report the CAP, not arithmetic: a turn that never hit
            // the budget must not claim it did just because a retry pushed the
            // model-call count to the ceiling.
            stepCapReached: stepCap.fired(),
            ...(mapper.lastToolName() ? { lastToolName: mapper.lastToolName() } : {}),
          }),
        });

        // Meter the turn (fire-and-forget by the caller). We hand the platform
        // seam the token counts + the model's catalog rates and let it compute
        // the equivalent cost with the shared formula (consistent with the
        // proxy/runner paths) rather than forwarding pi-ai's own `meta.costUsd`.
        if (modelBinding.metering.kind === "inline") {
          input.recordUsage({
            orgId: input.orgId,
            userId: input.userId,
            chatSessionId: input.chatSessionId,
            presetId: input.presetId,
            modelId: model.id,
            apiShape: model.api as ChatUsageRecord["apiShape"],
            inputTokens: meta.usage.input,
            outputTokens: meta.usage.output,
            cacheReadTokens: meta.usage.cacheRead,
            cacheWriteTokens: meta.usage.cacheWrite,
            cost: modelBinding.metering.cost,
            durationMs: Date.now() - startedAt,
          });
        }
      } catch (err) {
        // `createUIMessageStream` turns an escaped exception into a transient
        // error chunk. Without a start + finish boundary there is no assistant
        // message for the persistence drain to reconstruct after a reload.
        if (streamFinished) {
          logger.error("subscription chat failed after its finish chunk", { err: String(err) });
        } else {
          logger.error("subscription chat turn failed", {
            err: String(err),
            chatSessionId: input.chatSessionId,
          });
          for (const chunk of subscriptionFailureChunks({
            error: err,
            streamStarted,
            aborted: turnAbort.signal.aborted,
            abortReason: turnAbort.signal.reason,
            stepCount: mapper.stepCount(),
            stepCapReached: stepCap?.fired() ?? false,
            ...(mapper.lastToolName() ? { lastToolName: mapper.lastToolName() } : {}),
          })) {
            write(chunk);
          }
        }
      } finally {
        clearTimeout(deadline);
        abortSignal.removeEventListener("abort", forwardAbort);
        await mcpTools?.close();
      }
    },
  });

  // Release the concurrency slot once the response body has fully drained (or
  // been cancelled/errored) — it streams from `stream`, so the slot must
  // outlive the producer function.
  return createUIMessageStreamResponse({
    stream: releaseOnClose<UIMessageChunk>(stream, () => slot.release()),
  });
}
