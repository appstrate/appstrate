// SPDX-License-Identifier: Apache-2.0

/**
 * `runPiChat` is the single in-process server engine for Pi-selected chat turns.
 *
 * Runs a `@earendil-works/pi-coding-agent` session in the `apps/api` process,
 * driven by the Pi SDK (`@earendil-works/pi-ai`), which natively emits each
 * provider's request shape from either a real OAuth token or the llm-proxy
 * transport. OAuth examples include the
 * Anthropic OAuth fingerprint (`sk-ant-oat…` → beta + claude-cli UA + system
 * prelude) and the codex-responses headers (`chatgpt-account-id` decoded from the
 * token JWT). The platform forges nothing; request-shape fidelity is delegated
 * to Pi. API-key providers keep their secret behind llm-proxy. Every selected
 * provider rides this one loop.
 *
 * The chat runs server-side, so a real OAuth token is registered
 * directly in an in-memory {@link ModelRuntime} (never persisted, never handed to
 * the client) — no sidecar/gateway bearer-swap is needed (that only exists for
 * containerised RUNS, where the token must stay out of the agent container).
 *
 * The Pi session's event stream is mapped onto the AI-SDK UI-message-stream
 * ({@link PiChatUiStreamMapper}), the exact protocol the chat client already
 * has always consumed.
 */

import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import {
  loadPiCodingAgentSdk,
  derivePiCompactionSettings,
  prepareRequestedThinkingLevel,
  setPiRuntimeCredential,
} from "@appstrate/runner-pi";
import { CHAT_TOOL_STEP_BUDGET, CHAT_TURN_DEADLINE_MS } from "@appstrate/core/chat-turn-metadata";
import type { ChatUsageRecord } from "@appstrate/core/chat-contract";
import { applyOperationIndexPolicy } from "../operation-index.ts";
import { logger } from "../logger.ts";
import { PiChatUiStreamMapper } from "./ui-stream-mapper.ts";
import type { AgentSessionEvent } from "./pi-events.ts";
import { buildPlatformMcpTools } from "./mcp-tools.ts";
import { releaseOnClose, type PiChatSlot } from "./concurrency.ts";
import { createStepCapController, type PiChatSession } from "./turn-control.ts";
import type { ModelGenerationSettings } from "@appstrate/core/model-generation";
import { ChatTurnDeadlineError, closePiTurn } from "./pi-turn-closure.ts";
import {
  PI_CHAT_MODEL_RUNTIME_CREATE_OPTIONS,
  type ResolvedPiChatModelBinding,
} from "./model-binding.ts";
import { buildStructuredPiTurn, reconstructPiSession } from "./structured-session.ts";
import { createPiChatResourceLoader, PI_CHAT_AGENT_DIR, PI_CHAT_CWD } from "./resource-loader.ts";

export interface PiChatInput {
  /** Capacity reserved by the route before it persists the user turn. */
  slot: PiChatSlot;
  /** Resolved Pi model, authentication transport and metering ownership. */
  modelBinding: ResolvedPiChatModelBinding;
  /** Appstrate preset id (org model row id) — stored as `llm_usage.model`. */
  presetId: string;
  orgId: string;
  userId: string;
  /** Chat session the turn belongs to (null for an ephemeral, unpersisted turn). */
  chatSessionId: string | null;
  /** Canonical active UIMessage branch, including the current user head. */
  messages: UIMessage[];
  /** Base system persona (+ caller context) — MCP instructions are appended here. */
  system: string;
  generation: ModelGenerationSettings;
  /**
   * Platform HTTP MCP server (meta-tools) — the engine opens its own client.
   *
   * `fetch` is the transport for that handshake: production hands in the
   * platform's in-process dispatch so the three JSON-RPC hops re-enter the Hono
   * app directly rather than opening real loopback sockets to this same process.
   * Omitted → global `fetch`.
   */
  platformMcp: { url: string; headers: Record<string, string>; fetch?: typeof fetch };
  /** Aborts when the turn is explicitly stopped (decoupled from client disconnect). */
  abortSignal: AbortSignal;
  /** Maps a thrown error to a client-safe message. */
  onError: (error: unknown) => string;
  /** Persist one metered `llm_usage` row for the turn (fire-and-forget). */
  recordUsage: (record: ChatUsageRecord) => void;
}

/**
 * Drive one admitted Pi chat turn and return the UI-message-stream `Response`.
 */
export function runPiChat(input: PiChatInput): Response {
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

      // Safe with respect to the closing path: `closePiTurn` only emits a
      // compensating `start` when `streamStarted` is false, so a construction
      // failure closes a turn that is already open rather than one that never
      // began — the same start/finish envelope either way.
      //
      // The write itself sits INSIDE the try below, not here. It was the one
      // unconditional `write` outside it: if `writer.write` throws (a closed or
      // errored controller answers `TypeError: Invalid state`), the exception
      // escapes `execute` with no `finish` written at all, `onError` emits a
      // transient `error` chunk, and `extractAssistantMessage` turns that into
      // nothing — the turn vanishes on reload instead of showing as failed.
      // Moving it inside costs nothing (the deadline timer is created either
      // way) and is also what keeps the compensating-`start` branch reachable
      // rather than dead code with five tests behind it.

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
        // Open the stream NOW, before any of the turn's construction work. This
        // chunk carries nothing but a message id, and it is what flips the
        // client from "sending" to "the assistant is answering". It used to be
        // written after the platform-MCP handshake, the Pi SDK's dynamic import
        // and the agent-session construction — three round trips and a ~200 ms
        // module evaluation during which the response body stayed empty and the
        // user saw nothing. The HTTP response itself was already on its way
        // (this producer runs eagerly and `runPiChat` returns synchronously),
        // so the silence bought nothing.
        write(mapper.startChunk(crypto.randomUUID()));

        // Platform meta-tools (search/describe/invoke_operation + run_and_wait),
        // and the Pi SDK's value graph. They are independent — the SDK import
        // reads no MCP result — so they run together rather than back to back.
        // The SDK module evaluation is the expensive half on a cold process
        // (~200 ms, see `pi-sdk.ts`); the handshake is three JSON-RPC hops.
        //
        // A MCP failure is a genuine misconfiguration (the chat's value IS the
        // tools) — let it propagate to `onError`.
        // `allSettled`, not `all`: `all` rejects on the first failure, so an SDK
        // import error would abandon a handshake still in flight and strand the
        // MCP client it goes on to open — `finally` cannot close what was never
        // assigned. Waiting for both outcomes keeps teardown total.
        const [toolsResult, sdkResult] = await Promise.allSettled([
          buildPlatformMcpTools({
            url: platformMcp.url,
            headers: platformMcp.headers,
            writeChunk: write,
            signal: turnAbort.signal,
            ...(platformMcp.fetch ? { fetch: platformMcp.fetch } : {}),
            // Budget seam: the turn deadline bounds every run_and_wait, and the
            // live step count feeds the per-step budget note the model reads.
            turnBudget: {
              deadlineAt: turnDeadlineAt,
              stepCount: () => mapper.stepCount(),
              chatSessionId: input.chatSessionId,
              orgId: input.orgId,
            },
          }),
          loadPiCodingAgentSdk(),
        ]);
        // Adopt the client BEFORE rethrowing, so the outer `finally` owns it on
        // every path — exactly as it did when these ran back to back.
        if (toolsResult.status === "fulfilled") mcpTools = toolsResult.value;
        if (toolsResult.status === "rejected") throw toolsResult.reason;
        if (sdkResult.status === "rejected") throw sdkResult.reason;
        const sdk = sdkResult.value;
        const tools = toolsResult.value;

        const {
          createAgentSession,
          DefaultResourceLoader,
          estimateTokens,
          ModelRuntime,
          SessionManager,
          SettingsManager,
        } = sdk;

        const piModel = model;
        const requestedThinkingLevel = input.generation.reasoningLevel ?? "medium";
        const {
          model: sessionModel,
          thinkingLevel,
          thinkingBudgets,
        } = prepareRequestedThinkingLevel(piModel, requestedThinkingLevel);

        // Assemble the FINAL system prompt here, before the turn is projected,
        // so `baseTokens` below can be measured on the string Pi actually sends.
        // It used to be built 46 lines further down, after the projection, which
        // meant the compaction baseline silently omitted the multi-KB MCP
        // instructions + operation index.
        //
        // `applyOperationIndexPolicy` is applied to the MCP instructions ALONE,
        // not to the concatenation. The policy slices from the FIRST occurrence
        // of `## Operation index` to the end of the string, and `input.system`
        // carries org-authored text (agent display names, descriptions) — an
        // agent named after the heading would truncate the whole prompt. The
        // heading only ever legitimately appears in the server's instructions,
        // so cutting there and concatenating afterwards removes the hazard by
        // construction. See the note in `chat-stream.ts` that documents it.
        const mcpInstructions = tools.instructions
          ? applyOperationIndexPolicy(tools.instructions, model.api)
          : undefined;
        const system = mcpInstructions ? `${input.system}\n\n${mcpInstructions}` : input.system;

        const projectedTurn = buildStructuredPiTurn(
          input.messages,
          {
            api: sessionModel.api,
            provider: sessionModel.provider,
            model: sessionModel.id,
          },
          {
            estimateTokens,
            // The system prompt is part of every request Pi sends, so it counts
            // toward the context the compaction threshold is measured against.
            // Still a floor, not a measurement: tool schemas and this turn's own
            // prompt text are not in it (`projectedTurn.prompt` is not history).
            // That gap is pre-existing — do not close it silently, `contextTokens`
            // seeds Pi's compaction threshold via `historyUsage`.
            baseTokens: estimateTokens({
              role: "user",
              content: [{ type: "text", text: system }],
              timestamp: 0,
            }),
          },
        );
        const sessionManager = reconstructPiSession(SessionManager, projectedTurn.history);
        logger.info("Pi chat session reconstructed", {
          chatSessionId: input.chatSessionId,
          branchHeadId: projectedTurn.branchHeadId,
          modelId: sessionModel.id,
          sourceMessageCount: projectedTurn.sourceMessageCount,
          toolCallCount: projectedTurn.toolCallCount,
          toolResultCount: projectedTurn.toolResultCount,
          contextTokens: projectedTurn.contextTokens,
          sessionFile: sessionManager.getSessionFile() ?? null,
        });

        // OAuth uses the real access token in memory. A proxy-routed model
        // registers only the inert `proxy` placeholder — enough to satisfy the
        // provider's "some credential is configured" check; the bearer that
        // actually authorizes the call is minted per request by the binding's
        // `before_provider_headers` extension. Registration carries no `api` or
        // `baseUrl`: pi-ai builds every request URL from `model.baseUrl` (which
        // already points at the llm-proxy) and picks the serializer from
        // `model.api`, so declaring either on the provider would be dead weight.
        // `registerProvider` (not `setRuntimeApiKey`) keeps that placeholder
        // synchronous and purely in-memory — no credential-state sync on the
        // turn's critical path.
        const modelRuntime = await ModelRuntime.create(PI_CHAT_MODEL_RUNTIME_CREATE_OPTIONS);
        if (modelBinding.authMode === "proxy") {
          modelRuntime.registerProvider(modelBinding.provider, {
            apiKey: modelBinding.runtimeApiKey,
          });
        } else {
          await setPiRuntimeCredential(
            modelRuntime,
            modelBinding.provider,
            modelBinding.runtimeApiKey,
          );
        }

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
        const authExtensions =
          modelBinding.authMode === "proxy" ? [modelBinding.authExtension] : [];
        const resourceLoader = await createPiChatResourceLoader({
          DefaultResourceLoader,
          SettingsManager,
          extensionFactories: [
            ...tools.extensionFactories,
            ...authExtensions,
            ...generationExtensions,
          ],
          systemPrompt: system,
        });

        const { session } = await createAgentSession({
          cwd: PI_CHAT_CWD,
          agentDir: PI_CHAT_AGENT_DIR,
          model: sessionModel,
          thinkingLevel,
          modelRuntime,
          resourceLoader,
          sessionManager,
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
          await Promise.race([
            // `expandPromptTemplates` defaults to true, which routes a message
            // starting with "/" into Pi's extension-command dispatch. Chat text
            // is user prose, never a Pi command: the resource loader already
            // disables skills and prompt templates, and the chat extensions
            // register tools only — pin the invariant rather than depend on it.
            typedSession.prompt(projectedTurn.prompt, { expandPromptTemplates: false }),
            abortPromise,
          ]);
          // Early-stopping generate: the tool loop was cut at
          // CHAT_TOOL_STEP_BUDGET, so spend the last step on ONE tool-less model
          // call — the user gets a synthesis of the work already done instead of
          // a truncated tool call.
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

        // Close the turn through the shared emitter (`pi-turn-closure.ts`) — the
        // same sequence the catch below uses. Invariant: an errored turn ALWAYS
        // surfaces a visible error. Raw Pi / provider text is classified there,
        // before it crosses the stream or persistence boundary; the client
        // localizes the stable category.
        const meta = mapper.result();
        const stepCount = mapper.stepCount();
        const closing = closePiTurn({
          error:
            meta.errorText ?? (meta.finishReason === "error" ? "unknown model error" : undefined),
          finishReason: meta.finishReason,
          streamStarted,
          aborted: turnAbort.signal.aborted,
          abortReason: turnAbort.signal.reason,
          stepCount,
          // Both flags report the CAP, not arithmetic: a turn that never hit
          // the budget must not claim it did just because a retry pushed the
          // model-call count to the ceiling.
          stepCapReached: stepCap.fired(),
          ...(mapper.lastToolName() ? { lastToolName: mapper.lastToolName() } : {}),
        });
        // Same invariant, second failure mode: a turn killed by the deadline
        // used to end in complete silence. The emitter gives it a REAL text part
        // — an `error` chunk is transient and never becomes a persisted part.
        if (closing.deadlineReached) {
          logger.warn("chat turn deadline reached", {
            chatSessionId: input.chatSessionId,
            stepCount,
            deadlineMs: CHAT_TURN_DEADLINE_MS,
          });
        }
        for (const chunk of closing.chunks) write(chunk);

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
          logger.error("Pi chat failed after its finish chunk", { err: String(err) });
        } else {
          logger.error("Pi chat turn failed", {
            err: String(err),
            chatSessionId: input.chatSessionId,
          });
          const aborted = turnAbort.signal.aborted;
          const closing = closePiTurn({
            // An abort is a normal ending (the user already knows) — there is
            // no error to surface, and the turn finishes as a plain stop.
            ...(aborted ? {} : { error: err }),
            finishReason: aborted ? "stop" : "error",
            streamStarted,
            aborted,
            abortReason: turnAbort.signal.reason,
            stepCount: mapper.stepCount(),
            stepCapReached: stepCap?.fired() ?? false,
            ...(mapper.lastToolName() ? { lastToolName: mapper.lastToolName() } : {}),
          });
          for (const chunk of closing.chunks) write(chunk);
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
    stream: releaseOnClose<UIMessageChunk>(stream, () => input.slot.release()),
  });
}
