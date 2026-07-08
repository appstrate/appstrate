// SPDX-License-Identifier: Apache-2.0

/**
 * PiRunner — AFPS {@link Runner} implementation backed by the
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
  loadPiCodingAgentSdk,
  type AuthStorage,
  type ExtensionFactory,
  type Api,
  type KnownApi,
  type Model,
} from "./pi-sdk.ts";
import type { ModelApiShape } from "@appstrate/core/sidecar-types";
import { deriveResponseReserveTokens } from "@appstrate/core/token-budget";
import type { RunEvent, ExecutionContext } from "@appstrate/afps-runtime/types";
import {
  buildError,
  buildMetric,
  buildProgress,
  buildToolResultProgress,
  buildToolStartProgress,
  emptyRunResult,
  finalizeThrownFailure,
  reduceEvents,
  truncateToolResult,
  toolResultByteLimit,
  zeroTokenUsage,
  type RunError,
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
   * LLM API key. Registered on a {@link AuthStorage} under `model.provider`.
   * Callers can also pass a pre-built `authStorage` to wire multi-provider auth.
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
   * {@link Runner} contract does not mandate where tools come from — in
   * AFPS tools come from spawned `mcp-server` packages and
   * integrations; callers map those to Pi extension factories before
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
  /**
   * Tool names whose first successful execution ends the run. When one of
   * these tools completes without error the runner aborts the Pi session
   * instead of paying one more LLM round-trip for a trailing text-only turn
   * whose content is never delivered (the platform's communication contract
   * routes everything through tools). Appstrate passes `["output"]` when the
   * agent declares the `output` runtime tool. The abort raced here is
   * recognised by the bridge and does NOT count as a terminal failure.
   * Default: none (external consumers keep the SDK's natural stop).
   */
  terminalTools?: string[];
}

/**
 * Fallback context window when the model omits it. Matches the Claude
 * family's standard 200 k window — the most common runtime target.
 */
const DEFAULT_CONTEXT_WINDOW = 200_000;
/**
 * Floor on `keepRecentTokens`. Below ~20k the agent loses meaningful
 * recent context (a few thousand tokens of recent tool calls + the last
 * user message) and starts replaying earlier turns. 20k is small enough
 * to fit even tiny context windows once `reserveTokens` is subtracted.
 */
const MIN_KEEP_RECENT_TOKENS = 20_000;
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
 * | `reserveTokens`    | `deriveResponseReserveTokens(ctx, max)`| Response budget. Honours `max_tokens` so the first call post-compaction does not underflow into the upstream 400 ("prompt is too long") — critical for Claude Sonnet thinking mode (`maxTokens: 64000`). An impossible `max_tokens >= contextWindow` (corrupt catalog data) is clamped to a derived default instead of pinning the threshold at ≤0. |
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
  // Shared clamp (see `@appstrate/core/token-budget`): honours a usable
  // `maxTokens`, but treats an impossible `maxTokens >= contextWindow`
  // (corrupt catalog/override data) as unset and derives a sane reserve —
  // otherwise the compaction threshold `contextWindow - reserveTokens`
  // collapses to ≤0 and the agent compacts on every turn.
  const reserveTokens = deriveResponseReserveTokens(contextWindow, model.maxTokens);
  const keepRecentTokens = Math.max(
    MIN_KEEP_RECENT_TOKENS,
    Math.floor(contextWindow * KEEP_RECENT_FRACTION),
  );
  return { enabled: true, reserveTokens, keepRecentTokens };
}

// The `MODEL_API` → provider-key map lives in `provider-map.ts` (no Pi SDK
// import) so boot-critical callers can pull it without dragging this module's
// SDK graph. Re-exported here so the historical `pi-runner.ts` import path
// keeps resolving.
export { PROVIDER_BY_API, deriveProviderFromApi } from "./provider-map.ts";

// Compile error if appstrate ever declares an apiShape Pi does not know.
type _ApiShapeSubsetOfPi = ModelApiShape extends KnownApi ? true : never;
const _assertApiShapeSubsetOfPi: _ApiShapeSubsetOfPi = true;
void _assertApiShapeSubsetOfPi;

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

    // Hard timeout watchdog. An internal controller fires on EITHER the AFPS
    // `signal` (cancellation, forwarded below) OR this run's wall-clock budget,
    // measured from `runStart` (boot/cold-start already excluded — the platform
    // arms a longer safety net that folds it in). `executeSession` races the
    // prompt against THIS combined signal, but `finalizeThrownFailure` still
    // inspects the ORIGINAL `signal`: a real cancel (signal.aborted) takes the
    // abort-rethrow arm; a timeout (signal.aborted === false) finalizes a
    // first-class `timeout` terminal in the catch below.
    const runStart = Date.now();
    const timeoutSeconds = context.timeoutSeconds ?? 0;
    let timedOut = false;
    const runController = new AbortController();
    const forwardAbort = (): void => runController.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) runController.abort(signal.reason);
      else signal.addEventListener("abort", forwardAbort, { once: true });
    }
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutSeconds > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        runController.abort(new Error("pi-runner: run timeout watchdog"));
      }, timeoutSeconds * 1000);
    }
    const clearRunTimeout = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (signal) signal.removeEventListener("abort", forwardAbort);
    };

    try {
      await this.executeSession(context, internalSink, runController.signal, captureBridge);
    } catch (err) {
      clearRunTimeout();

      // Runner-enforced timeout: a first-class `timeout` terminal (explicit
      // status + `Run timed out after Ns` message + an execution-window
      // duration), distinct from the generic failure epilogue below. Gated on
      // `!signal.aborted` so a real cancellation racing the watchdog still
      // takes `finalizeThrownFailure`'s abort-rethrow arm.
      if (timedOut && !signal?.aborted) {
        const bridge = bridgeRef.current;
        await finalizeThrownFailure({
          events,
          err,
          signal,
          runId,
          now: Date.now,
          emit,
          drainAndEmit: () => bridge?.drainPending() ?? Promise.resolve(),
          eventSink,
          usage: bridge?.getUsage() ?? { input_tokens: 0, output_tokens: 0 },
          terminalStatus: "timeout",
          buildError: () => ({
            code: "timeout",
            message: `Run timed out after ${timeoutSeconds}s`,
          }),
          stamp: (result) => {
            if (bridge) result.cost = bridge.getCost();
            result.durationMs = Date.now() - runStart;
          },
        });
        return;
      }
      // Shared thrown-failure epilogue (abort-rethrow → emit appstrate.error →
      // best-effort drain → reduce → stamp usage/cost → finalize). The Pi runner
      // leaves `status` unset on this path (setFailedStatus: false, preserved
      // verbatim) and sources usage + cost from the session bridge — both only
      // when the bridge was captured; a very early throw stamps explicit zero
      // usage. The "drain" here converges the bridge's pending fire-and-forget emits
      // (`drainPending`) before finalize closes the sink, not a runtime-event
      // journal; it emits nothing new, so reducing before vs after it is
      // equivalent.
      const bridge = bridgeRef.current;
      await finalizeThrownFailure({
        events,
        err,
        signal,
        runId,
        now: Date.now,
        emit,
        drainAndEmit: () => bridge?.drainPending() ?? Promise.resolve(),
        eventSink,
        usage: bridge?.getUsage() ?? { input_tokens: 0, output_tokens: 0 },
        setFailedStatus: false,
        stamp: (result) => {
          if (bridge) result.cost = bridge.getCost();
        },
      });
      return;
    }
    // Session ran to completion — stand the timeout watchdog down.
    clearRunTimeout();

    // Authoritative terminal verdict, captured by the bridge while it
    // streamed `message_end` events. When the agent loop ended on an
    // errored/aborted FINAL assistant turn, this is the RunError to stamp;
    // a transient error mid-loop that the agent recovered from leaves a
    // clean final assistant turn → undefined → success. Read from the
    // bridge (not `session.state.messages`) so trailing non-assistant
    // entries — toolResults, compaction summaries appended after an
    // overflow error (#464) — cannot mask the real terminal turn. This
    // makes the runner the single source of truth for the run's outcome
    // instead of having the platform reconstruct it from the `run_logs`
    // adapter-error trail post-hoc (issue: run_fd977eb6).
    const result: RunResult = events.length === 0 ? emptyRunResult() : reduceEvents(events);
    const terminalError = bridgeRef.current?.getTerminalError();
    if (terminalError) {
      result.status = "failed";
      result.error = terminalError;
    } else {
      // Set success explicitly (don't leave it for the ingestion layer to
      // infer) so the runner is the single source of truth on BOTH branches.
      result.status = "success";
    }
    attachAccumulators(result);
    // Drain pending bridge fires BEFORE finalize. Finalize closes the
    // server-side sink via CAS — any POST in flight after that lands
    // gets a 410 and is silently dropped in the bridge's catch handler.
    if (bridgeRef.current) {
      await bridgeRef.current.drainPending();
    }
    await eventSink.finalize(result);
  }

  /**
   * Drive one Pi SDK session to completion. The terminal success/failure
   * verdict is NOT returned here — it is captured by the bridge as it
   * streams (`SessionBridgeHandle.getTerminalError`) and read by `run()`
   * after this resolves, so trailing non-assistant messages cannot mask
   * the final assistant turn's outcome.
   */
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

    // Load the heavy Pi SDK value surface here (not at module top) so the
    // ~200ms `@mariozechner/pi-coding-agent` eval stays off the runtime's
    // pre-session boot path. ESM caches the module, so when the container
    // entrypoint has already warmed it during provisioning this await resolves
    // instantly.
    const {
      AuthStorage,
      createAgentSession,
      DefaultResourceLoader,
      ModelRegistry,
      SessionManager,
      SettingsManager,
    } = await loadPiCodingAgentSdk();

    const authStorage =
      this.opts.authStorage ??
      AuthStorage.create(this.opts.authStoragePath ?? "/tmp/pi-auth/auth.json");
    if (!this.opts.authStorage && apiKey) {
      // `model.provider` is the Pi SDK's AuthStorage key the SDK resolves
      // credentials against; register the key under the same value.
      authStorage.setRuntimeApiKey(model.provider, apiKey);
    } else if (!this.opts.authStorage && !apiKey) {
      // No injected AuthStorage AND no runtime key — the SDK will call the
      // provider unauthenticated and 401/retry silently (the platform's
      // kickoff fail-fast should prevent this, so reaching here means a
      // run bypassed that guard). Surface a line on the surprising path.
      // runner-pi intentionally avoids a logger dep — same console.error
      // JSON convention as the compaction-wait + sink-heartbeat paths.
      console.error(
        JSON.stringify({
          level: "warn",
          msg: "[pi-runner] no API key for model — provider calls will be unauthenticated",
          provider: model.provider,
        }),
      );
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
        // Pi SDK's built-in retry (Retry-After honoring + jitter) covers
        // transient 429/5xx upstream — including OpenAI's mid-stream 5xx
        // `server_error`, which the Codex/Responses adapter surfaces as a
        // failed turn. 4 attempts (was 2) rides out the short upstream
        // blips that 2 retries occasionally exhausted, before the agent
        // loop has to self-recover. Operators can opt out by setting
        // `MODEL_RETRY_ENABLED=false` on the runtime env when stacking
        // external retry middleware.
        retry:
          process.env.MODEL_RETRY_ENABLED === "false"
            ? { enabled: false }
            : { enabled: true, maxRetries: 4 },
      }),
    });

    const terminalTools = this.opts.terminalTools ?? [];
    const bridge = installSessionBridge(session, internalSink, context.runId, {
      terminalTools,
      // Early-stop: abort the SDK loop as soon as a terminal tool has
      // executed successfully. `session.abort()` resolves once the agent
      // is idle; detached because the bridge callback is synchronous.
      onTerminalTool: () => {
        void session.abort().catch(() => {});
      },
    });
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

    // #464 — Pi SDK's auto-compaction recovery is fire-and-forget: an
    // `agent_end` event with overflow status triggers a background
    // `_runAutoCompaction(...)` that `session.prompt()` does NOT await.
    // Without this wait, the entrypoint can `process.exit(0)` before
    // the compaction LLM call has a chance to start, and the next run
    // turn re-encounters the same prompt-too-long 400. Polling
    // `isCompacting` here lets that recovery actually drain.
    await waitForCompactionToSettle(session as unknown as { isCompacting?: boolean }, signal);
  }
}

/**
 * Maximum time to wait for a fire-and-forget Pi SDK compaction pass
 * before falling through. Compaction is a single LLM call against the
 * summarisation model — 60 s covers a 200 k-token Anthropic round-trip
 * with a comfortable margin. Beyond this, the platform's outer run
 * timeout (#PLATFORM_RUN_LIMITS.timeout_ceiling_seconds, default 1800 s)
 * remains the authoritative ceiling.
 */
const COMPACTION_WAIT_TIMEOUT_MS = 60_000;
/** Poll cadence for {@link waitForCompactionToSettle}. */
const COMPACTION_POLL_INTERVAL_MS = 100;

/**
 * Drain Pi SDK's fire-and-forget compaction pass before the caller
 * returns. The SDK schedules `_runAutoCompaction` from `_handleAgentEvent`
 * — a queued promise nobody awaits — so `session.prompt()` resolves
 * the moment the agent loop yields, leaving compaction (if any) racing
 * the next `process.exit`. We poll `session.isCompacting` here with a
 * bounded timeout; the upstream run timeout remains the authoritative
 * ceiling beyond that.
 *
 * Exported for unit testing — production callers go through
 * `PiRunner.executeSession` which feeds the SDK session in directly.
 *
 * @internal
 */
export async function waitForCompactionToSettle(
  session: { isCompacting?: boolean },
  signal?: AbortSignal,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  if (typeof session.isCompacting !== "boolean") return; // SDK older than 0.70 — best-effort no-op.
  if (!session.isCompacting) return;
  const timeoutMs = options.timeoutMs ?? COMPACTION_WAIT_TIMEOUT_MS;
  const pollMs = options.pollIntervalMs ?? COMPACTION_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  while (session.isCompacting) {
    if (signal?.aborted) return;
    if (Date.now() >= deadline) {
      // Only surface a line on the surprising path — happy-path
      // compactions resolve silently. runner-pi intentionally avoids
      // a logger dep, so the existing console.error convention from
      // sink-heartbeat applies.
      console.error(
        JSON.stringify({
          level: "warn",
          msg: "[pi-runner] compaction wait timed out",
          timeoutMs,
        }),
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
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
  /**
   * Terminal run verdict, derived from the LAST assistant turn the bridge
   * observed. Returns a {@link RunError} when that turn ended with
   * `stopReason` `"error"` or `"aborted"`; `undefined` otherwise (clean
   * stop, or a transient error the agent recovered from before a later
   * clean turn). Tracked from the `message_end` event stream — NOT read
   * from `session.state.messages` — so trailing non-assistant entries
   * (toolResults, compaction summaries appended after an overflow error,
   * #464) cannot mask the real terminal turn. `run()` reads this to stamp
   * `RunResult.status`.
   */
  getTerminalError(): RunError | undefined;
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

// Tool-result truncation (byte-aware, env-tunable via `TOOL_RESULT_BYTE_LIMIT`)
// lives in `@appstrate/afps-runtime/runner` (imported above for the bridge's
// own use). Re-exported here for this package's existing test imports + public
// surface.
export { truncateToolResult, toolResultByteLimit };

/**
 * True when a settled assistant turn's `stopReason` represents a terminal
 * failure — `"error"` (provider/stream failure, incl. overflow, which the
 * SDK surfaces as a stopReason="error" turn) or `"aborted"` (a provider-side
 * abort that did not propagate as a thrown cancellation; a user cancel
 * travels the abort-signal throw path in `run()` instead, so it never
 * reaches here). Shared by the live `appstrate.error` emit and
 * `getTerminalError()` so the `run_logs` visibility row always matches the
 * stamped terminal verdict.
 */
function isTerminalErrorStop(stopReason: string | undefined): boolean {
  return stopReason === "error" || stopReason === "aborted";
}

/**
 * Human-facing message for a terminal-error turn: the SDK's `errorMessage`
 * when present, else a generic fallback. Both stop reasons carry an
 * `errorMessage` by SDK contract; the fallback guards the rare empty case.
 */
function terminalErrorMessage(errorMessage: string | undefined): string {
  return typeof errorMessage === "string" && errorMessage.length > 0
    ? errorMessage
    : "The agent's final model turn ended in an error";
}

export interface SessionBridgeOptions {
  /**
   * Tool names whose first successful `tool_execution_end` marks the run
   * as complete. See {@link PiRunnerOptions.terminalTools}.
   */
  terminalTools?: string[];
  /**
   * Invoked once, synchronously, when a terminal tool completes without
   * error. The runner uses this to abort the SDK loop early.
   */
  onTerminalTool?: () => void;
}

export function installSessionBridge(
  session: BridgeableSession,
  sink: InternalSink,
  runId: string,
  options: SessionBridgeOptions = {},
): SessionBridgeHandle {
  const terminalTools = options.terminalTools ?? [];
  // Set once a terminal tool (e.g. `output`) has executed successfully.
  // From that point the run is semantically complete: the early-stop abort
  // the runner fires may surface as a trailing `stopReason: "aborted"`
  // assistant turn, which must NOT be read as a terminal failure.
  let terminalToolCompleted = false;
  // Token usage accumulator across all assistant turns (shared zero-shape).
  const totalUsage: TokenUsage = zeroTokenUsage();
  let totalCost = 0;

  // Terminal verdict tracking. Updated on every assistant `message_end`,
  // so after the loop settles these hold the LAST assistant turn's outcome
  // — robust against trailing non-assistant messages (toolResults,
  // compaction summaries) that `session.state.messages.at(-1)` would
  // surface instead. Read via `getTerminalError()`.
  let lastAssistantStopReason: string | undefined;
  let lastAssistantErrorMessage: string | undefined;

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
    const promise: Promise<void> = sink
      .emit(event)
      .catch(() => {})
      .finally(() => {
        pendingFires.delete(promise);
      });
    pendingFires.add(promise);
  };

  session.subscribe((rawEvent) => {
    const event = rawEvent as PiSubscribedEvent;
    switch (event.type) {
      case "message_end": {
        const entries = session.state.messages;
        if (!entries.length) break;
        const last = entries[entries.length - 1] as PiAssistantMessage | undefined;
        if (last?.role !== "assistant") break;

        // Record this assistant turn's terminal outcome. Overwritten each
        // turn → ends as the FINAL assistant turn's stopReason once the
        // loop settles (mirrors the SDK's own `_lastAssistantMessage`).
        lastAssistantStopReason = last.stopReason;
        lastAssistantErrorMessage = last.errorMessage;

        // Accumulate token usage. Pi SDK exposes the legacy
        // `{ input, output, cacheRead, cacheWrite }` shape on
        // `message.usage`; map once into the canonical snake_case
        // total so every downstream emit reads the same fields.
        const u = last.usage;
        if (u) {
          const inputDelta = u.input ?? 0;
          const outputDelta = u.output ?? 0;
          totalUsage.input_tokens = (totalUsage.input_tokens ?? 0) + inputDelta;
          totalUsage.output_tokens = (totalUsage.output_tokens ?? 0) + outputDelta;
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
            fire(buildMetric({ runId, timestamp: Date.now() }, { ...totalUsage }, totalCost));
          }
        }

        // SDK error (e.g. LLM API unreachable, auth failures) or a
        // provider-side abort. Mirror `getTerminalError()`'s verdict so a
        // terminal `aborted` turn — or an `error` turn the SDK left without
        // an `errorMessage` — still lands a `run_logs` row, not just a
        // bare `runs.error`. A transient error turn the agent later
        // recovers from also logs here (harmless — the trail no longer
        // drives status).
        // Suppress the verdict for the abort we raced ourselves after a
        // terminal tool completed — the run is already semantically done
        // (mirrored in `getTerminalError()` so log trail and stamped
        // status stay consistent).
        if (
          isTerminalErrorStop(last.stopReason) &&
          !(terminalToolCompleted && last.stopReason === "aborted")
        ) {
          fire(
            buildError({ runId, timestamp: Date.now() }, terminalErrorMessage(last.errorMessage)),
          );
        }

        // Full assistant text (for progress display)
        const content = last.content;
        if (Array.isArray(content)) {
          const text = content
            .filter((c): c is PiTextContent => c.type === "text")
            .map((c) => c.text || "")
            .join("\n");
          if (text) {
            fire(buildProgress({ runId, timestamp: Date.now() }, text));
          }
        }
        break;
      }

      case "tool_execution_start": {
        const e = event as PiToolExecutionStartEvent;
        // `toolCallId` is the Pi SDK's per-call identifier; forwarding it lets
        // sinks correlate start/end events when multiple tools run concurrently
        // (the LLM can dispatch a parallel batch and the results land
        // out-of-order). Optional — omitted from `data` when the SDK gave none.
        fire(
          buildToolStartProgress(
            { runId, timestamp: Date.now() },
            {
              tool: e.toolName,
              args: e.args,
              ...(e.toolCallId !== undefined ? { toolCallId: e.toolCallId } : {}),
            },
          ),
        );
        break;
      }

      case "tool_execution_end": {
        // Symmetric counterpart of `tool_execution_start`. Forwards the tool's
        // result (truncated to TOOL_RESULT_BYTE_LIMIT) and an explicit `isError`
        // flag so sinks can colour-code success vs error paths without
        // re-parsing the result. Same `appstrate.progress` envelope as the start
        // event (shared builder) — adding a new canonical type would force a
        // migration on every consumer (web, run_logs, JSONL, HTTP sink) for
        // marginal gain over the discriminator `data.result !== undefined`.
        const e = event as PiToolExecutionEndEvent;
        const tool = e.toolName ?? "unknown";
        fire(
          buildToolResultProgress(
            { runId, timestamp: Date.now() },
            {
              tool,
              result: truncateToolResult(e.result),
              isError: e.isError === true,
              ...(e.toolCallId !== undefined ? { toolCallId: e.toolCallId } : {}),
            },
          ),
        );
        // Early-stop on the first SUCCESSFUL terminal tool. A failed call
        // (e.g. output-schema validation error) does not qualify — the
        // model gets its retry turn as before.
        if (!terminalToolCompleted && e.isError !== true && terminalTools.includes(tool)) {
          terminalToolCompleted = true;
          options.onTerminalTool?.();
        }
        break;
      }

      case "agent_end": {
        fire(buildMetric({ runId, timestamp: Date.now() }, { ...totalUsage }, totalCost));
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
    getTerminalError(): RunError | undefined {
      // Verdict on the LAST assistant turn. `isTerminalErrorStop` /
      // `terminalErrorMessage` are shared with the live `appstrate.error`
      // emit above, so the stamped status and the `run_logs` trail can
      // never disagree on what counts as a terminal failure.
      // A trailing "aborted" turn AFTER a successful terminal tool is the
      // runner's own early-stop, not a failure.
      if (terminalToolCompleted && lastAssistantStopReason === "aborted") {
        return undefined;
      }
      if (!isTerminalErrorStop(lastAssistantStopReason)) {
        return undefined;
      }
      return { code: "adapter_error", message: terminalErrorMessage(lastAssistantErrorMessage) };
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
