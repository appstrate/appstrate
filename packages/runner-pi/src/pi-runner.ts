// SPDX-License-Identifier: Apache-2.0

/**
 * PiRunner — AFPS 1.3 {@link Runner} implementation backed by the
 * {@link https://www.npmjs.com/package/@mariozechner/pi-coding-agent | Pi Coding Agent SDK}.
 *
 * The same class runs inside an Appstrate agent container (via
 * `runtime-pi/entrypoint.ts`) and on any developer laptop / server
 * with an LLM API key. Parity is structural: the code path is
 * identical, only the {@link EventSink} differs (stdout JSONL in the
 * container, HTTP / memory / console elsewhere).
 *
 * Responsibilities:
 *   1. Subscribe to Pi SDK session events.
 *   2. Translate each Pi event into a canonical AFPS {@link RunEvent}
 *      and forward to the sink.
 *   3. Honour cancellation via the caller's `AbortSignal`.
 *   4. Finalise the sink with the reducer-produced {@link RunResult}.
 *
 * What this module intentionally DOES NOT do:
 *   - Build the system prompt. Callers provide it via
 *     {@link PiRunnerOptions.systemPrompt} (Appstrate passes its
 *     enriched platform prompt; minimal consumers can pass
 *     `renderTemplate(bundle.prompt, view)`).
 *   - Manage Docker / sandboxing. Those are orchestration concerns.
 *   - Persist memories / state. The sink is responsible.
 */

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { RunEvent, ExecutionContext } from "@appstrate/afps-runtime/types";
import {
  emptyRunResult,
  reduceEvents,
  type RunOptions,
  type Runner,
  type RunResult,
  type TokenUsage,
} from "@appstrate/afps-runtime/runner";

/**
 * Pi model configuration. Mirrors the Pi SDK's `Model<Api>` shape so
 * callers familiar with the Pi ecosystem get a drop-in fit; kept as its
 * own alias so we can evolve the Runner contract without tracking every
 * Pi SDK type move.
 */
export type PiModelConfig = Model<Api>;

export interface PiRunnerOptions {
  /** LLM model configuration passed to the Pi SDK. Required. */
  model: PiModelConfig;
  /**
   * LLM API key. Registered on a {@link AuthStorage} under the provider
   * derived from `model.api`. Callers can also pass a pre-built
   * `authStorage` to wire multi-provider auth.
   */
  apiKey?: string;
  /**
   * Agent's system prompt. This is the static instruction Pi SDK stores
   * on every session; in Appstrate it is the full enriched prompt built
   * by `buildPlatformSystemPrompt`. Minimal consumers can pass
   * `renderTemplate(bundle.prompt, buildPromptView(context))`.
   */
  systemPrompt: string;
  /**
   * Message to drive the first agent turn. Defaults to `systemPrompt`,
   * which matches Appstrate's historical behaviour (the Pi SDK seeds the
   * conversation with the full enriched prompt). External consumers may
   * prefer a distinct user-facing message (e.g. a specific instruction
   * derived from `context.input`).
   */
  startMessage?: string;
  /** Working directory for the Pi session. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Directory Pi SDK uses for per-session scratch. Defaults to `/tmp/pi-agent`. */
  agentDir?: string;
  /**
   * Tool extension factories to load into the Pi SDK session. The AFPS
   * {@link Runner} contract does not mandate where tools come from —
   * callers typically resolve them from the bundle via a
   * {@link ToolResolver} and map to Pi extension factories before
   * constructing the Runner. Default: empty (no extensions).
   */
  extensionFactories?: ExtensionFactory[];
  /**
   * Custom {@link AuthStorage}. When provided, the runner will not
   * register `apiKey` under a derived provider — callers control all
   * auth state.
   */
  authStorage?: AuthStorage;
  /** Path where the default auth store persists. Ignored if `authStorage` is set. */
  authStoragePath?: string;
  /** Pi SDK thinking level. Defaults to `"medium"`. */
  thinkingLevel?: "low" | "medium" | "high";
}

/**
 * Convert a Pi `MODEL_API` string into the provider key the Pi SDK's
 * {@link AuthStorage} uses to look up API keys.
 */
function deriveProviderFromApi(api: string): string {
  const known: Record<string, string> = {
    "anthropic-messages": "anthropic",
    "openai-completions": "openai",
    "openai-responses": "openai",
    "mistral-conversations": "mistral",
    "google-generative-ai": "google",
    "google-vertex": "google-vertex",
    "azure-openai-responses": "azure-openai-responses",
    "bedrock-converse-stream": "amazon-bedrock",
  };
  const provider = known[api];
  if (!provider) throw new Error(`PiRunner: unknown model api "${api}"`);
  return provider;
}

export class PiRunner implements Runner {
  readonly name = "pi-runner";

  protected readonly opts: PiRunnerOptions;

  constructor(opts: PiRunnerOptions) {
    this.opts = opts;
  }

  async run(options: RunOptions): Promise<void> {
    const { context, eventSink, signal } = options;
    signal?.throwIfAborted();

    const runId = context.runId;
    const events: RunEvent[] = [];

    const emit = async (event: RunEvent): Promise<void> => {
      events.push(event);
      await eventSink.handle(event);
    };

    // Wrap the sink so every internally-emitted event is both captured
    // (for the reducer) and forwarded to the caller's sink.
    const internalSink: InternalSink = { emit };

    // The bridge handle is captured via callback (not return value) so
    // it survives a mid-session throw — the catch branch still needs
    // `bridge.getUsage()` / `bridge.getCost()` to ship the partial
    // counters with the failure finalize, and a thrown executeSession
    // can never deliver a return value. A holder object dodges TS's
    // strict-flow narrowing of a `let` set across an async closure.
    const bridgeRef: { current: SessionBridgeHandle | null } = { current: null };
    const captureBridge = (handle: SessionBridgeHandle): void => {
      bridgeRef.current = handle;
    };

    const attachAccumulators = (result: RunResult): void => {
      // Authoritative usage + cost travel with the finalize POST so the
      // platform does not depend on the side-channel `appstrate.metric`
      // having been ingested first. The metric event is now purely a
      // live-UI signal whose POST may be aborted by `process.exit(0)`
      // after `run()` returns — finalize body covers persistence and
      // cost accounting on its own.
      const bridge = bridgeRef.current;
      if (bridge) {
        result.usage = bridge.getUsage();
        result.cost = bridge.getCost();
      }
    };

    try {
      await this.executeSession(context, internalSink, signal, captureBridge);
    } catch (err) {
      if (signal?.aborted) {
        // Cancellation: propagate without finalizing — the caller's
        // finally block decides.
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      await emit({
        type: "appstrate.error",
        timestamp: Date.now(),
        runId,
        message,
      });
      const result = reduceEvents(events, {
        error: { message, stack: err instanceof Error ? err.stack : undefined },
      });
      attachAccumulators(result);
      await eventSink.finalize(result);
      return;
    }

    const result: RunResult = events.length === 0 ? emptyRunResult() : reduceEvents(events);
    attachAccumulators(result);
    await eventSink.finalize(result);
  }

  protected async executeSession(
    context: ExecutionContext,
    internalSink: InternalSink,
    signal: AbortSignal | undefined,
    onBridgeReady?: (handle: SessionBridgeHandle) => void,
  ): Promise<void> {
    const { model, apiKey, systemPrompt, startMessage } = this.opts;
    const cwd = this.opts.cwd ?? process.cwd();
    const agentDir = this.opts.agentDir ?? "/tmp/pi-agent";
    const thinkingLevel = this.opts.thinkingLevel ?? "medium";

    const authStorage =
      this.opts.authStorage ??
      AuthStorage.create(this.opts.authStoragePath ?? "/tmp/pi-auth/auth.json");
    if (!this.opts.authStorage && apiKey) {
      const provider = deriveProviderFromApi(model.api);
      authStorage.setRuntimeApiKey(provider, apiKey);
    }

    const modelRegistry = ModelRegistry.create(authStorage);

    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      extensionFactories: this.opts.extensionFactories ?? [],
      noExtensions: (this.opts.extensionFactories ?? []).length === 0,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel,
      authStorage,
      modelRegistry,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 2 },
      }),
    });

    const bridge = installSessionBridge(session, internalSink, context.runId);
    // Hand the bridge to `run()` immediately so a throw from
    // `session.prompt()` further down does not lose the accumulator.
    onBridgeReady?.(bridge);

    // Cancellation: Pi SDK does not expose a native abort. We race the
    // prompt against the signal and let the caller's abort bubble up.
    const abortPromise = signal
      ? new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(signal.reason ?? new Error("Run cancelled"));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        })
      : null;

    const promptPromise = session.prompt(startMessage ?? systemPrompt);
    if (abortPromise) {
      await Promise.race([promptPromise, abortPromise]);
    } else {
      await promptPromise;
    }
  }
}

// ─── Pi SDK → RunEvent bridge ──────────────────────────────────────

export interface InternalSink {
  emit(event: RunEvent): Promise<void>;
}

/**
 * Returned by {@link installSessionBridge}. The Pi SDK's `subscribe`
 * callback is synchronous and the bridge fires `sink.emit(...)` as
 * fire-and-forget — the handle exposes the running accumulators so the
 * caller can attach them to the terminal {@link RunResult}. These are
 * the authoritative copies the platform reads at finalize, decoupling
 * correctness from whether the side-channel `appstrate.metric` POST has
 * landed yet.
 */
export interface SessionBridgeHandle {
  /** Snapshot of token usage accumulated across the session so far. */
  getUsage(): TokenUsage;
  /** Snapshot of total LLM cost in USD accumulated across the session so far. */
  getCost(): number;
}

/**
 * Minimal Pi SDK session surface consumed by the bridge. Narrowed to
 * `subscribe` + a read-only view of `state.messages` so tests can pass
 * a hand-rolled fake without reimplementing the full Pi SDK session.
 */
export interface BridgeableSession {
  subscribe(cb: (event: unknown) => void): void;
  state: { messages: unknown[] };
}

/**
 * Subscribe to a Pi SDK session and translate each event into a
 * canonical AFPS {@link RunEvent} emitted on the internal sink.
 *
 * Mapping:
 *   - `message_end`    (assistant_message)     → `appstrate.progress`
 *   - `message_end`    (stopReason=error)      → `appstrate.error`
 *   - `tool_execution_start`                   → `appstrate.progress` + data
 *   - `agent_end` (last turn usage aggregate)  → `appstrate.metric`
 *
 * The bridge deliberately does NOT forward `message_update` / `text_delta`
 * streaming chunks. A 1000-token assistant reply would otherwise produce
 * ~1000 signed HTTP POSTs + `run_logs` rows + frontend aggregation work,
 * all describing content that's already delivered whole at `message_end`.
 * Runs here are autonomous (fire-and-forget) so token-level live feedback
 * is speculative UX; the message-level granularity suffices.
 *
 * Structured canonical events (memory.added, pinned.set, output.emitted,
 * log.written) are produced by tool extensions that
 * call an EventSink directly — this bridge handles only the Pi SDK
 * framing, not payload emission.
 */
interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}
interface PiTextContent {
  type: "text";
  text?: string;
}
interface PiAssistantMessage {
  role: "assistant";
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
  content?: Array<PiTextContent | { type: string }>;
}
interface PiToolExecutionStartEvent {
  type: "tool_execution_start";
  toolName?: string;
  args?: unknown;
}
type PiSubscribedEvent = { type: string } & Record<string, unknown>;

export function installSessionBridge(
  session: BridgeableSession,
  sink: InternalSink,
  runId: string,
): SessionBridgeHandle {
  // Token usage accumulator across all assistant turns.
  const totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

  // Fire-and-forget emit. Rejections are swallowed so a transient sink
  // failure never propagates as an unhandled rejection out of the
  // synchronous Pi SDK callback. Authoritative data still reaches the
  // platform via `getUsage` / `getCost` on the finalize body.
  const fire = (event: RunEvent): void => {
    sink.emit(event).catch(() => {});
  };

  session.subscribe((rawEvent) => {
    const event = rawEvent as PiSubscribedEvent;
    switch (event.type) {
      case "message_end": {
        const entries = session.state.messages;
        if (!entries.length) break;
        const last = entries[entries.length - 1] as PiAssistantMessage | undefined;
        if (last?.role !== "assistant") break;

        // Accumulate token usage
        const u = last.usage;
        if (u) {
          totalUsage.input += u.input ?? 0;
          totalUsage.output += u.output ?? 0;
          totalUsage.cacheRead += u.cacheRead ?? 0;
          totalUsage.cacheWrite += u.cacheWrite ?? 0;
          totalUsage.cost += u.cost?.total ?? 0;
        }

        // SDK error (e.g. LLM API unreachable, auth failures)
        if (last.stopReason === "error" && last.errorMessage) {
          fire({
            type: "appstrate.error",
            timestamp: Date.now(),
            runId,
            message: String(last.errorMessage),
          });
        }

        // Full assistant text (for progress display)
        const content = last.content;
        if (Array.isArray(content)) {
          const text = content
            .filter((c): c is PiTextContent => c.type === "text")
            .map((c) => c.text || "")
            .join("\n");
          if (text) {
            fire({
              type: "appstrate.progress",
              timestamp: Date.now(),
              runId,
              message: text,
            });
          }
        }
        break;
      }

      case "tool_execution_start": {
        const e = event as PiToolExecutionStartEvent;
        fire({
          type: "appstrate.progress",
          timestamp: Date.now(),
          runId,
          message: `Tool: ${e.toolName ?? "unknown"}`,
          data: { tool: e.toolName, args: e.args },
        });
        break;
      }

      case "agent_end": {
        fire({
          type: "appstrate.metric",
          timestamp: Date.now(),
          runId,
          usage: {
            input_tokens: totalUsage.input,
            output_tokens: totalUsage.output,
            cache_creation_input_tokens: totalUsage.cacheWrite,
            cache_read_input_tokens: totalUsage.cacheRead,
          },
          cost: totalUsage.cost,
        });
        break;
      }

      default:
        break;
    }
  });

  return {
    getUsage(): TokenUsage {
      return {
        input_tokens: totalUsage.input,
        output_tokens: totalUsage.output,
        cache_creation_input_tokens: totalUsage.cacheWrite,
        cache_read_input_tokens: totalUsage.cacheRead,
      };
    },
    getCost(): number {
      return totalUsage.cost;
    },
  };
}
