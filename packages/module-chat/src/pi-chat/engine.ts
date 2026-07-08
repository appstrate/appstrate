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
 * to Pi. This replaces the old per-vendor "official binary" chat engines (Claude
 * Agent SDK) and their per-provider `registerChatHandler` seam.
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
  deriveProviderFromApi,
  type Api,
  type Model,
} from "@appstrate/runner-pi";
import { mergeTurnMetadata, CHAT_MAX_STEPS } from "@appstrate/core/chat-turn-metadata";
import { OPERATION_INDEX_HEADING, type SubscriptionChatModel } from "@appstrate/core/chat-contract";
import type { ChatUsageRecord } from "@appstrate/core/chat-contract";
import { logger } from "../logger.ts";
import { PiChatUiStreamMapper } from "./ui-stream-mapper.ts";
import type { AgentSessionEvent } from "./pi-events.ts";
import { buildPlatformMcpTools } from "./mcp-tools.ts";
import { acquirePiChatSlot, chatCapacityResponse } from "./concurrency.ts";

/**
 * Wall-clock ceiling for a single chat turn. A turn fans out into up to
 * CHAT_MAX_STEPS steps (each possibly long-polling a run for ~55 s), so the
 * budget is generous; it exists to stop a wedged upstream stream from holding a
 * concurrency slot forever.
 */
const TURN_DEADLINE_MS = 10 * 60_000;

export interface PiSubscriptionChatInput {
  /** Resolved subscription model + fresh real access token. */
  model: SubscriptionChatModel;
  /** Appstrate preset id (org model row id) — stored as `llm_usage.model`. */
  presetId: string;
  orgId: string;
  userId: string;
  /** Pre-assembled transcript prompt for this turn. */
  prompt: string;
  /** Base system persona (+ caller context) — MCP instructions are appended here. */
  system: string;
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

  const { model, platformMcp, abortSignal, onError } = input;
  const mapper = new PiChatUiStreamMapper();
  const startedAt = Date.now();

  const stream = createUIMessageStream({
    onError,
    execute: async ({ writer }) => {
      const write = (chunk: UIMessageChunk): void => writer.write(chunk);

      // Deadline + explicit-stop → one combined abort threaded into the prompt.
      const turnAbort = new AbortController();
      const forwardAbort = (): void => turnAbort.abort(abortSignal.reason);
      if (abortSignal.aborted) turnAbort.abort(abortSignal.reason);
      else abortSignal.addEventListener("abort", forwardAbort, { once: true });
      const deadline = setTimeout(
        () => turnAbort.abort(new Error("chat turn deadline")),
        TURN_DEADLINE_MS,
      );

      // Platform meta-tools (search/describe/invoke_operation + run_and_wait).
      // A failure here is a genuine misconfiguration (the chat's value IS the
      // tools) — let it propagate to `onError`.
      const mcpTools = await buildPlatformMcpTools({
        url: platformMcp.url,
        headers: platformMcp.headers,
        writeChunk: write,
        signal: turnAbort.signal,
      });

      try {
        const {
          AuthStorage,
          createAgentSession,
          DefaultResourceLoader,
          ModelRegistry,
          SessionManager,
          SettingsManager,
        } = await loadPiCodingAgentSdk();

        const provider = deriveProviderFromApi(model.apiShape as Api);
        const piModel: Model<Api> = {
          id: model.modelId,
          name: model.modelId,
          api: model.apiShape as Api,
          provider,
          baseUrl: model.baseUrl,
          reasoning: model.reasoning,
          input: (model.input ?? ["text"]) as Model<Api>["input"],
          cost: (model.cost ?? { input: 0, output: 0 }) as Model<Api>["cost"],
          contextWindow: model.contextWindow ?? undefined,
          maxTokens: model.maxTokens ?? undefined,
        } as Model<Api>;

        // Real subscription token in-memory only — pi-ai emits the OAuth request
        // shape from it natively (never persisted, never sent to the client).
        const authStorage = AuthStorage.inMemory();
        authStorage.setRuntimeApiKey(provider, model.accessToken);
        const modelRegistry = ModelRegistry.create(authStorage);

        // MCP server usage guidance is appended to the system prompt, then the
        // (uncacheable) operation index is dropped for providers without a
        // prompt cache — mirrors the ai-sdk path's `applyOperationIndexPolicy`.
        let system = mcpTools.instructions
          ? `${input.system}\n\n${mcpTools.instructions}`
          : input.system;
        system = dropOperationIndexForUncached(system, model.apiShape);

        const resourceLoader = new DefaultResourceLoader({
          cwd: "/tmp",
          agentDir: "/tmp/pi-chat",
          settingsManager: SettingsManager.inMemory(),
          extensionFactories: mcpTools.extensionFactories,
          noExtensions: false,
          noPromptTemplates: true,
          noThemes: true,
          systemPrompt: system,
        });
        await resourceLoader.reload();

        const { session } = await createAgentSession({
          cwd: "/tmp",
          agentDir: "/tmp/pi-chat",
          model: piModel,
          thinkingLevel: "medium",
          authStorage,
          modelRegistry,
          resourceLoader,
          sessionManager: SessionManager.inMemory(),
          settingsManager: SettingsManager.inMemory({
            compaction: derivePiCompactionSettings(piModel),
            retry: { enabled: true, maxRetries: 4 },
          }),
          // Chat must NOT get the built-in host tools (read/bash/edit/write) —
          // only the platform MCP meta-tools (extension tools stay enabled).
          noTools: "builtin",
        });

        write(mapper.startChunk(crypto.randomUUID()));

        const typedSession = session as unknown as {
          subscribe(cb: (event: unknown) => void): void;
          prompt(message: string): Promise<void>;
          abort?(): Promise<void>;
        };
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
        } catch (err) {
          // An explicit stop / deadline surfaces as an abort — end the turn
          // gracefully (the partial stream is already delivered) rather than
          // throwing into the client. A genuine engine error still flows to the
          // finish chunk via the mapper's captured stopReason.
          void typedSession.abort?.().catch(() => {});
          if (!turnAbort.signal.aborted) throw err;
        }

        const meta = mapper.result();
        if (meta.errorText) write({ type: "error", errorText: meta.errorText });

        const stepCount = mapper.stepCount();
        write({
          type: "finish",
          messageMetadata: mergeTurnMetadata(undefined, {
            engine: "subscription",
            finishReason: meta.finishReason,
            stepCount,
            maxSteps: CHAT_MAX_STEPS,
            maxStepsReached: stepCount >= CHAT_MAX_STEPS,
            ...(mapper.lastToolName() ? { lastToolName: mapper.lastToolName() } : {}),
          }),
        });

        // Meter the turn (fire-and-forget by the caller). pi-ai pre-computes
        // per-message cost, accumulated by the mapper.
        input.recordUsage({
          orgId: input.orgId,
          userId: input.userId,
          presetId: input.presetId,
          modelId: model.modelId,
          apiShape: model.apiShape,
          inputTokens: meta.usage.input,
          outputTokens: meta.usage.output,
          cacheReadTokens: meta.usage.cacheRead,
          cacheWriteTokens: meta.usage.cacheWrite,
          costUsd: meta.costUsd,
          durationMs: Date.now() - startedAt,
        });
      } finally {
        clearTimeout(deadline);
        abortSignal.removeEventListener("abort", forwardAbort);
        await mcpTools.close();
      }
    },
  });

  // Release the concurrency slot once the producer has fully drained — the
  // response body streams from `stream`, so the slot must outlive it.
  const release = () => slot.release();
  return createUIMessageStreamResponse({
    stream: stream.pipeThrough(releaseOnClose(release)),
  });
}

/**
 * Drop the trailing operation index (fenced by {@link OPERATION_INDEX_HEADING})
 * for providers without a prompt cache — the multi-KB index would otherwise be
 * re-sent uncached every step. Mirrors `applyOperationIndexPolicy` on the ai-sdk
 * path; kept local so the engine owns the full system-prompt assembly.
 */
function dropOperationIndexForUncached(system: string, apiShape: string): string {
  const uncached = apiShape === "mistral-conversations" || apiShape === "openai-codex-responses";
  if (uncached && system.includes(OPERATION_INDEX_HEADING)) {
    return system.slice(0, system.indexOf(OPERATION_INDEX_HEADING)).trimEnd();
  }
  return system;
}

/**
 * A passthrough transform that runs `onClose` exactly once when the UI-message
 * stream ends (flush) — used to release the concurrency slot after the response
 * body has fully drained, not when the producer function returns.
 */
function releaseOnClose(onClose: () => void): TransformStream<UIMessageChunk, UIMessageChunk> {
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    try {
      onClose();
    } catch (err) {
      logger.warn("pi chat slot release failed", { err: String(err) });
    }
  };
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    flush() {
      fire();
    },
  });
}
