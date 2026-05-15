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

// ─── Run trace ────────────────────────────────────────────────────
//
// Diagnostic trace lines for the agent → platform event pipeline. Each
// line is a JSON object on stderr, prefixed with `[run-trace]` so it can
// be tee'd / grepped separately from the stdout JSONL bridge. Disabled
// when `APPSTRATE_RUN_TRACE !== "1"` so production builds pay only the
// env-var check (one branch, no allocation).
const RUN_TRACE_ENABLED = process.env.APPSTRATE_RUN_TRACE === "1";

export function runTrace(event: string, data: Record<string, unknown>): void {
  if (!RUN_TRACE_ENABLED) return;
  try {
    process.stderr.write(`[run-trace] ${JSON.stringify({ ts: Date.now(), event, ...data })}\n`);
  } catch {
    // stderr write failures are non-fatal — diagnostics must never break
    // the run.
  }
}

function extractToolCallId(event: RunEvent): string | undefined {
  const data = (event as { data?: unknown }).data;
  if (typeof data === "object" && data !== null && "toolCallId" in data) {
    const id = (data as { toolCallId?: unknown }).toolCallId;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

// Count of bridge fire() promises that have not resolved yet. Read by
// pi-runner.run() before/after executeSession and finalize so we can spot
// in-flight POSTs that risk being killed by `process.exit(0)`.
let bridgePendingFires = 0;

export function getBridgePendingCount(): number {
  return bridgePendingFires;
}

/**
 * Default response budget when the model carries no `maxTokens`.
 * 16384 covers the common "no thinking" Claude / GPT response shape;
 * models with larger budgets (Claude Sonnet thinking @ 64k) override
 * via `model.maxTokens` and `reserveTokens` follows.
 */
const DEFAULT_RESERVE_TOKENS = 16384;
/**
 * Floor on `keepRecentTokens`. Below ~20k the agent loses meaningful
 * recent context (a few thousand tokens of recent tool calls + the last
 * user message) and starts replaying earlier turns. 20k is small enough
 * to fit even tiny context windows once `reserveTokens` is subtracted.
 */
const MIN_KEEP_RECENT_TOKENS = 20_000;
/**
 * Fallback context window when the model omits it. Matches the Claude
 * family's standard 200k window — the most common runtime target.
 */
const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Fraction of the context window to keep verbatim after a compaction pass. */
const KEEP_RECENT_FRACTION = 0.1;

/**
 * Derive Pi SDK compaction settings from a resolved model. Pure function
 * so the env-driven (`SYSTEM_PROVIDER_KEYS`) and DB-driven (`org_models`)
 * paths get identical compaction sizing for the same `(contextWindow,
 * maxTokens)` pair.
 *
 * | Knob               | Mapping                                | Why                                                                                                                                                                              |
 * |--------------------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
 * | `reserveTokens`    | `model.maxTokens ?? 16384`             | Response budget. MUST be ≥ `max_tokens` or the first call post-compaction underflows and the upstream 400 ("prompt is too long") reappears. Critical for Claude Sonnet thinking mode (`maxTokens: 64000`). |
 * | `keepRecentTokens` | `max(20000, 10% × contextWindow)`      | Preserves the ratio across model sizes: 20k on Claude 200k, ~100k on GPT-4.1 1M, ~200k on Gemini 2M. The floor stops small windows from over-compacting away recent context.    |
 *
 * Operators can disable compaction entirely with
 * `MODEL_COMPACTION_ENABLED=false` (mirrors the existing
 * `MODEL_RETRY_ENABLED` pattern) — useful when stacking external
 * compaction middleware. See appstrate#445.
 */
export function derivePiCompactionSettings(
  model: { contextWindow?: number | null; maxTokens?: number | null },
  env: Record<string, string | undefined> = process.env,
): { enabled: false } | { enabled: true; reserveTokens: number; keepRecentTokens: number } {
  if (env["MODEL_COMPACTION_ENABLED"] === "false") return { enabled: false };
  const contextWindow = model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const reserveTokens = model.maxTokens ?? DEFAULT_RESERVE_TOKENS;
  const keepRecentTokens = Math.max(
    MIN_KEEP_RECENT_TOKENS,
    Math.floor(contextWindow * KEEP_RECENT_FRACTION),
  );
  return { enabled: true, reserveTokens, keepRecentTokens };
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
    "openai-codex-responses": "openai",
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
      const t0 = Date.now();
      runTrace("pi-runner.emit.start", {
        runId,
        type: event.type,
        toolCallId: extractToolCallId(event),
        eventsLen: events.length,
      });
      try {
        await eventSink.handle(event);
        runTrace("pi-runner.emit.end", {
          runId,
          type: event.type,
          toolCallId: extractToolCallId(event),
          latencyMs: Date.now() - t0,
        });
      } catch (err) {
        runTrace("pi-runner.emit.error", {
          runId,
          type: event.type,
          toolCallId: extractToolCallId(event),
          latencyMs: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
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
      runTrace("pi-runner.executeSession.resolved", {
        runId,
        emittedCount: events.length,
        pendingBridgeFires: getBridgePendingCount(),
      });
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
      // Same drain rationale as the happy path — pending bridge fires
      // on the error trail (last tool_execution_end before the throw,
      // etc.) still need to land before finalize closes the sink.
      if (bridgeRef.current) {
        await bridgeRef.current.drainPending();
      }
      await eventSink.finalize(result);
      return;
    }

    const result: RunResult = events.length === 0 ? emptyRunResult() : reduceEvents(events);
    attachAccumulators(result);
    // Drain pending bridge fires BEFORE finalize. Finalize closes the
    // server-side sink via CAS, so any POST still in flight after that
    // lands gets a 410 and silently dies in the bridge's catch handler
    // — this is the canonical "missing tool_execution_end rows on
    // bursty turns" bug we kept reproducing.
    if (bridgeRef.current) {
      runTrace("pi-runner.drain.start", {
        runId,
        pendingBridgeFires: getBridgePendingCount(),
      });
      await bridgeRef.current.drainPending();
      runTrace("pi-runner.drain.end", {
        runId,
        pendingBridgeFires: getBridgePendingCount(),
      });
    }
    runTrace("pi-runner.finalize.start", {
      runId,
      emittedCount: events.length,
      pendingBridgeFires: getBridgePendingCount(),
    });
    await eventSink.finalize(result);
    runTrace("pi-runner.finalize.end", {
      runId,
      pendingBridgeFires: getBridgePendingCount(),
    });
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
        compaction: derivePiCompactionSettings(model, process.env),
        // Pi SDK's built-in retry (Retry-After honoring + jitter, max 2
        // attempts) covers transient 429/5xx upstream. Operators can
        // opt out by setting `MODEL_RETRY_ENABLED=false` on the runtime
        // env when stacking external retry middleware.
        retry:
          process.env.MODEL_RETRY_ENABLED === "false"
            ? { enabled: false }
            : { enabled: true, maxRetries: 2 },
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
  /**
   * Wait until every fire-and-forget `sink.emit(event)` dispatched from
   * the Pi SDK subscribe callback has settled. The Pi SDK callback runs
   * synchronously and cannot be awaited, so the bridge dispatches each
   * sink write as a detached promise — `drainPending()` is the only
   * supported way to converge them. Callers MUST invoke this before
   * `sink.finalize()` because finalize closes the server-side sink, and
   * any POST still in flight after that lands on a closed sink (410)
   * and is silently dropped by the bridge's catch handler.
   */
  drainPending(): Promise<void>;
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
 *   - `tool_execution_start`                   → `appstrate.progress` + data { tool, args }
 *   - `tool_execution_end`                     → `appstrate.progress` + data { tool, result, isError }
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
  toolCallId?: string;
  args?: unknown;
}
interface PiToolExecutionEndEvent {
  type: "tool_execution_end";
  toolName?: string;
  toolCallId?: string;
  result?: unknown;
  isError?: boolean;
}
type PiSubscribedEvent = { type: string } & Record<string, unknown>;

/**
 * Hard ceiling on the byte size of a tool result payload forwarded as
 * `appstrate.progress.data.result`. Anything beyond this is replaced
 * with a `__truncated: true` marker so downstream sinks (HTTP POST to
 * the platform, JSONL stdout, web `run_logs` row) stay bounded —
 * filesystem/HTTP reads can produce MB-sized strings that have no
 * business sitting in a log row. Sinks render their own per-mode
 * preview length on top of this hard cap.
 *
 * Default sized for the typical "tail of a stack trace + a few JSON
 * blobs" — large enough to keep useful detail, small enough that 100
 * tool calls per run × 2KB = 200KB stays well below the platform's
 * `SIDECAR_MAX_MCP_ENVELOPE_BYTES` defaults and a single `run_logs`
 * row stays cheap.
 */
const TOOL_RESULT_BYTE_LIMIT = 2048;

/**
 * Truncate an arbitrary tool result for safe transport on the event
 * sink. Strategy:
 *   - `string` payloads: byte-aware truncation with a single trailing
 *     "...(truncated, N bytes)" marker so the rendered output stays
 *     valid UTF-8 and self-documents the truncation.
 *   - everything else: serialise to JSON, apply the same cap; on
 *     overflow return a structured marker preserving the original type
 *     hint and original byte size so sinks can render "[truncated …]"
 *     without re-serialising.
 *
 * Exposed for tests; not part of the bridge's public surface.
 */
export function truncateToolResult(
  result: unknown,
  limitBytes: number = TOOL_RESULT_BYTE_LIMIT,
): unknown {
  if (result === undefined || result === null) return result;
  if (typeof result === "string") {
    return truncateString(result, limitBytes);
  }
  // Booleans / numbers / bigint / symbols never trigger truncation.
  if (typeof result !== "object") return result;
  let serialised: string;
  try {
    serialised = JSON.stringify(result);
  } catch {
    // Circular / non-serialisable — replace with a structured marker.
    return { __truncated: true, reason: "non_serialisable" };
  }
  if (serialised === undefined) return result;
  const byteLength = Buffer.byteLength(serialised, "utf8");
  if (byteLength <= limitBytes) return result;
  // Re-parse so the sink still receives a structured payload (the
  // canonical event validators only accept plain JSON values, never
  // arbitrary class instances). Fallback to the marker on parse error.
  return {
    __truncated: true,
    reason: "size",
    bytes: byteLength,
    limit: limitBytes,
    preview: truncateString(serialised, Math.min(512, limitBytes)),
  };
}

function truncateString(s: string, limitBytes: number): string {
  const byteLength = Buffer.byteLength(s, "utf8");
  if (byteLength <= limitBytes) return s;
  // Walk back from the byte limit so the returned slice is a valid
  // UTF-8 boundary (Buffer.toString handles partial code points but
  // produces a replacement char — cheaper to land on a clean boundary).
  let cut = limitBytes;
  const buf = Buffer.from(s, "utf8");
  // UTF-8 continuation bytes have the bit pattern 10xxxxxx — walk
  // back until we land on a leading byte (or the start of the
  // buffer). `buf[cut]` may be undefined if `cut === buf.length`,
  // which is fine — `?? 0` short-circuits the loop in that case.
  while (cut > 0 && ((buf[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  const head = buf.subarray(0, cut).toString("utf8");
  return `${head}…(truncated, ${byteLength} bytes)`;
}

export function installSessionBridge(
  session: BridgeableSession,
  sink: InternalSink,
  runId: string,
): SessionBridgeHandle {
  // Token usage accumulator across all assistant turns. Snake-case to
  // match the canonical `TokenUsage` shape — no remap at emit time.
  const totalUsage: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let totalCost = 0;

  // Pending fire-and-forget emits. `fire()` dispatches each sink.emit
  // call without awaiting (the Pi SDK callback is synchronous), and
  // pushes the resulting promise here so `drainPending()` can await
  // them as a group before the runner reaches finalize. The Set is
  // self-pruning: each promise removes itself on settle.
  const pendingFires = new Set<Promise<void>>();

  // Fire-and-forget emit. Rejections are swallowed so a transient sink
  // failure never propagates as an unhandled rejection out of the
  // synchronous Pi SDK callback. Authoritative data still reaches the
  // platform via `getUsage` / `getCost` on the finalize body.
  const fire = (event: RunEvent): void => {
    bridgePendingFires += 1;
    runTrace("bridge.fire", {
      runId,
      type: event.type,
      toolCallId: extractToolCallId(event),
      pending: bridgePendingFires,
    });
    const promise: Promise<void> = sink
      .emit(event)
      .catch((err: unknown) => {
        runTrace("bridge.fire.error", {
          runId,
          type: event.type,
          toolCallId: extractToolCallId(event),
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        bridgePendingFires -= 1;
        pendingFires.delete(promise);
        runTrace("bridge.fire.settled", {
          runId,
          type: event.type,
          toolCallId: extractToolCallId(event),
          pending: bridgePendingFires,
        });
      });
    pendingFires.add(promise);
  };

  session.subscribe((rawEvent) => {
    const event = rawEvent as PiSubscribedEvent;
    runTrace("bridge.sdk_event", { runId, sdkType: event.type });
    switch (event.type) {
      case "message_end": {
        const entries = session.state.messages;
        if (!entries.length) break;
        const last = entries[entries.length - 1] as PiAssistantMessage | undefined;
        if (last?.role !== "assistant") break;

        // Accumulate token usage. Pi SDK exposes the legacy
        // `{ input, output, cacheRead, cacheWrite }` shape on
        // `message.usage`; map once into the canonical snake_case
        // total so every downstream emit reads the same fields.
        const u = last.usage;
        if (u) {
          const inputDelta = u.input ?? 0;
          const outputDelta = u.output ?? 0;
          totalUsage.input_tokens += inputDelta;
          totalUsage.output_tokens += outputDelta;
          totalUsage.cache_creation_input_tokens =
            (totalUsage.cache_creation_input_tokens ?? 0) + (u.cacheWrite ?? 0);
          totalUsage.cache_read_input_tokens =
            (totalUsage.cache_read_input_tokens ?? 0) + (u.cacheRead ?? 0);
          totalCost += u.cost?.total ?? 0;

          // Mid-run cumulative snapshot — fires after every assistant
          // turn so the platform can stream live cost to the UI. The
          // server upserts on the partial unique index with monotonic
          // semantics (latest cost wins), so a later `agent_end` emit
          // with the same totals is a no-op rather than a duplicate.
          // Skip the snapshot when the turn produced zero new tokens
          // (e.g. an empty-usage object or a tool-only step) — the
          // payload would be identical to the previous one and waste
          // a NOTIFY round-trip.
          if (inputDelta > 0 || outputDelta > 0) {
            fire({
              type: "appstrate.metric",
              timestamp: Date.now(),
              runId,
              usage: { ...totalUsage },
              cost: totalCost,
            });
          }
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
          // `toolCallId` is the Pi SDK's per-call identifier; forwarding
          // it lets sinks correlate start/end events when multiple
          // tools run concurrently (the LLM can dispatch a parallel
          // batch and the results land out-of-order). Optional —
          // omitted from `data` when the SDK didn't provide one.
          data: {
            tool: e.toolName,
            args: e.args,
            ...(e.toolCallId !== undefined ? { toolCallId: e.toolCallId } : {}),
          },
        });
        break;
      }

      case "tool_execution_end": {
        // Symmetric counterpart of `tool_execution_start`. Forwards the
        // tool's result (truncated to TOOL_RESULT_BYTE_LIMIT) and an
        // explicit `isError` flag so sinks can colour-code success vs
        // error paths without re-parsing the result. Same `appstrate.
        // progress` envelope as the start event — adding a new canonical
        // type would force a migration on every consumer (web, run_logs,
        // JSONL, HTTP sink) for marginal gain over the discriminator
        // `data.result !== undefined`.
        const e = event as PiToolExecutionEndEvent;
        const tool = e.toolName ?? "unknown";
        const isError = e.isError === true;
        const truncatedResult = truncateToolResult(e.result);
        fire({
          type: "appstrate.progress",
          timestamp: Date.now(),
          runId,
          message: `${isError ? "Tool error" : "Tool result"}: ${tool}`,
          data: {
            tool: e.toolName,
            result: truncatedResult,
            isError,
            ...(e.toolCallId !== undefined ? { toolCallId: e.toolCallId } : {}),
          },
        });
        break;
      }

      case "agent_end": {
        fire({
          type: "appstrate.metric",
          timestamp: Date.now(),
          runId,
          usage: { ...totalUsage },
          cost: totalCost,
        });
        break;
      }

      default:
        break;
    }
  });

  return {
    getUsage(): TokenUsage {
      return { ...totalUsage };
    },
    getCost(): number {
      return totalCost;
    },
    async drainPending(): Promise<void> {
      // Snapshot the current pending set: events fired AFTER drainPending
      // is called are not part of this drain window. In practice the
      // caller (pi-runner.run, just before finalize) runs after the
      // SDK's session.prompt() has resolved, so no fresh events should
      // arrive — but the Set semantics keep us honest if the SDK ever
      // changes its quiescence guarantees.
      const snapshot = [...pendingFires];
      if (snapshot.length === 0) return;
      await Promise.allSettled(snapshot);
    },
  };
}
