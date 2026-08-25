// SPDX-License-Identifier: Apache-2.0

/**
 * PiRunner — AFPS {@link Runner} implementation backed by the
 * {@link https://www.npmjs.com/package/@earendil-works/pi-coding-agent | Pi Coding Agent SDK}.
 *
 * The same class runs inside an Appstrate agent container (via
 * `runtime-pi/entrypoint.ts`) and on any developer laptop / server
 * with an LLM API key. Parity is structural: the code path is
 * identical, only the {@link EventSink} differs (an HMAC-signed HTTP
 * sink POSTing to the platform in the container, a console / in-memory
 * sink elsewhere).
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
  type ModelRuntime,
  type ExtensionFactory,
  type Api,
  type KnownApi,
  type Model,
  type PiSdkAgentSessionEvent,
  type Transport,
} from "./pi-sdk.ts";
import { scheduleDeadlineNudges } from "./deadline-nudges.ts";
import { ALIAS_PI_PROVIDER_KEY, PI_SDK_VERSION, PI_SDK_VERSION_HEADER } from "./provider-map.ts";
import type { ModelApiShape } from "@appstrate/core/sidecar-types";
import {
  anthropicThinkingBudgets,
  type ModelReasoningLevel,
} from "@appstrate/core/model-generation";
import { deriveResponseReserveTokens } from "@appstrate/core/token-budget";
import type { RunEvent, ExecutionContext } from "@appstrate/afps-runtime/types";
import {
  buildError,
  buildMetric,
  buildProgress,
  buildToolResultProgress,
  buildToolStartProgress,
  buildTurnProgress,
  emptyRunResult,
  finalizeThrownFailure,
  reduceEvents,
  truncateToolResult,
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

/**
 * The two levels Pi refuses to consider supported without an explicit
 * per-model mapping: `getSupportedThinkingLevels` (`pi-ai/models.js`) admits
 * `off`…`high` for any reasoning model but requires
 * `thinkingLevelMap[level] !== undefined` for these two, and
 * `AgentSession` clamps an unsupported request DOWN (`agent-session.js` →
 * `clampThinkingLevel`).
 */
const LEVELS_NEEDING_EXPLICIT_MAP = ["xhigh", "max"] as const;

function needsExplicitMap(
  level: ModelReasoningLevel,
): level is (typeof LEVELS_NEEDING_EXPLICIT_MAP)[number] {
  return (LEVELS_NEEDING_EXPLICIT_MAP as readonly string[]).includes(level);
}

/**
 * Keep a top-end thinking request intact instead of letting Pi silently
 * weaken it.
 *
 * Appstrate's catalog deliberately permits unknown capabilities so the
 * provider stays the final authority. Pi's default is the opposite for
 * {@link LEVELS_NEEDING_EXPLICIT_MAP}: absent a mapping it clamps down. A
 * pass-through entry (`xhigh → "xhigh"`, `max → "max"`) restores the platform's
 * intent — the request reaches the provider, which answers for itself.
 *
 * Two cases are left alone, both deliberate:
 *  - an explicit native mapping (`max → "high"`): the catalog already answered.
 *  - an explicit refusal (`max → null`): the catalog says the model cannot do
 *    it, so Pi's clamp is the correct outcome — forcing a pass-through here
 *    would override a fact the platform itself published.
 */
export function preserveRequestedThinkingLevel(
  model: PiModelConfig,
  level: PiRunnerOptions["thinkingLevel"],
): PiModelConfig {
  if (level === undefined || !needsExplicitMap(level) || !model.reasoning) return model;
  // `?? undefined`-free on purpose: `null` (explicit refusal) is NOT `undefined`
  // and must fall through to "leave the model alone".
  if (model.thinkingLevelMap?.[level] !== undefined) return model;
  return {
    ...model,
    thinkingLevelMap: { ...model.thinkingLevelMap, [level]: level },
  };
}

type PiThinkingBudgetLevel = Exclude<ModelReasoningLevel, "off" | "xhigh" | "max">;
type PiThinkingBudgets = Partial<Record<PiThinkingBudgetLevel, number>>;

function prepareAnthropicThinkingBudgets(
  model: PiModelConfig,
  level: ModelReasoningLevel,
): PiThinkingBudgets | undefined {
  if (model.api !== "anthropic-messages") return undefined;
  // The rule lives in core: the sidecar applies the identical one when it
  // re-originates an aliased run, whose container never reaches this branch.
  return anthropicThinkingBudgets(level);
}

/**
 * Pi 0.84 treats the Codex model base URL as the parent of `/responses`.
 * Appstrate's provider and sidecar contracts expose the parent of
 * `/codex/responses`, so retain that stable contract at our SDK boundary.
 */
function prepareProviderBaseUrl(model: PiModelConfig): PiModelConfig {
  if (model.api !== "openai-codex-responses") return model;
  const baseUrl = model.baseUrl.replace(/\/$/, "");
  if (baseUrl.endsWith("/codex")) return model;
  return { ...model, baseUrl: `${baseUrl}/codex` };
}

/**
 * Adapt a requested reasoning level to what Pi's session expects.
 *
 * Appstrate's portable vocabulary and Pi's `ThinkingLevel`
 * (`pi-agent-core`: `off | minimal | low | medium | high | xhigh | max`) are
 * the SAME seven values since Pi 0.84 — the level passes through unchanged.
 * Two adaptations remain, both about what Pi does with it afterwards:
 *
 *  - {@link preserveRequestedThinkingLevel} — stop Pi clamping a top-end
 *    request away for want of an explicit mapping.
 *  - {@link prepareAnthropicThinkingBudgets} — classic (non-adaptive)
 *    Anthropic requests need a request-scoped budget, because Pi's own table
 *    collapses `xhigh` AND `max` onto its `high` budget
 *    (`pi-ai/api/simple-options.js` → `clampReasoning`).
 *
 * Pre-0.84 this function also routed `max` through Pi's `xhigh` slot, since
 * `max` did not exist as a selector. It does now; the disguise is gone —
 * it clobbered the model's own `xhigh` mapping for the duration of the turn,
 * which the adaptive-Anthropic path reads back (`mapThinkingLevelToEffort`).
 */
export function prepareRequestedThinkingLevel(
  model: PiModelConfig,
  level: ModelReasoningLevel,
): {
  model: PiModelConfig;
  thinkingLevel: ModelReasoningLevel;
  thinkingBudgets?: PiThinkingBudgets;
} {
  const preparedModel = prepareProviderBaseUrl(model);
  const thinkingBudgets = prepareAnthropicThinkingBudgets(preparedModel, level);
  return {
    model: preserveRequestedThinkingLevel(preparedModel, level),
    thinkingLevel: level,
    ...(thinkingBudgets ? { thinkingBudgets } : {}),
  };
}

/**
 * Install an ephemeral credential on Pi 0.84's ModelRuntime.
 *
 * OpenAI Codex is OAuth-only in Pi's built-in catalog, so `setRuntimeApiKey`
 * deliberately refuses it. Appstrate already resolves and refreshes that
 * OAuth bearer outside Pi; a process-local provider overlay exposes the token
 * as request auth without persisting it or replacing Codex's native serializer.
 *
 * {@link ALIAS_PI_PROVIDER_KEY} needs `registerProvider` for a different
 * reason: `setRuntimeApiKey` only overlays an EXISTING provider, so a canonical
 * key pi knows no vendor for is dropped and `prepareRequest` later throws.
 */
export async function setPiRuntimeCredential(
  modelRuntime: ModelRuntime,
  provider: string,
  apiKey: string,
): Promise<void> {
  if (provider === ALIAS_PI_PROVIDER_KEY) {
    // Provider-config headers are the only ones `pi-messages` puts on the wire.
    // Alias-only: this header must never reach `openai-codex`.
    modelRuntime.registerProvider(provider, {
      apiKey,
      headers: { [PI_SDK_VERSION_HEADER]: PI_SDK_VERSION },
    });
    return;
  }
  if (provider === "openai-codex") {
    modelRuntime.registerProvider(provider, { apiKey });
    return;
  }
  await modelRuntime.setRuntimeApiKey(provider, apiKey);
}

export interface PiRunnerOptions {
  /** LLM model configuration passed to the Pi SDK. Required. */
  model: PiModelConfig;
  /** LLM API key. Registered on the runner's {@link ModelRuntime} under `model.provider`. */
  apiKey?: string;
  /**
   * No per-token rates for {@link model}; its zero rates are a placeholder the
   * Pi SDK's required `Model.cost` forced, so the runner omits cost entirely
   * rather than reporting a fabricated `0`. Token counts are unaffected.
   */
  unpriced?: boolean;
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
  /** Path where the credential store persists. Defaults to `/tmp/pi-auth/auth.json`. */
  authStoragePath?: string;
  /** Pi SDK thinking level. Defaults to `"medium"`. */
  thinkingLevel?: ModelReasoningLevel;
  /** Provider sampling temperature. Omitted to preserve provider/Pi defaults. */
  temperature?: number;
  /**
   * Preferred transport for providers that support multiple transports.
   * Providers that do not support this option ignore it. Defaults to `"auto"`.
   */
  transport?: Transport;
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
 *
 * Returns TWO members, and the split is load-bearing. `compaction` is exactly
 * the Pi SDK's `CompactionSettings` and is what gets handed to it. `contextWindow`
 * is OURS: the fallback-resolved number this session really runs against, which
 * {@link installSessionBridge} stamps on every turn breadcrumb as the denominator
 * of the run's context gauge (so it stays meaningful with compaction off).
 * Returning it here keeps the fallback in ONE place, so the number emitted
 * cannot drift from the number handed to the SDK.
 *
 * Nested rather than flat because the SDK declares no `contextWindow` and its
 * settings type is all-optional: a flat result assigns to `CompactionSettings`
 * with no error, so nothing would stop a call site from posting our key into a
 * third party's settings object. Under this shape that is `TS2559` at the call
 * site — the boundary is enforced by the compiler instead of by a convention.
 */
export function derivePiCompactionSettings(
  model: { contextWindow?: number | null; maxTokens?: number | null },
  env: Record<string, string | undefined> = process.env,
): {
  compaction:
    { enabled: false } | { enabled: true; reserveTokens: number; keepRecentTokens: number };
  contextWindow: number;
} {
  const contextWindow = model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  if (env["MODEL_COMPACTION_ENABLED"] === "false") {
    return { compaction: { enabled: false }, contextWindow };
  }
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
  return { compaction: { enabled: true, reserveTokens, keepRecentTokens }, contextWindow };
}

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
    const requestedThinkingLevel = this.opts.thinkingLevel ?? "medium";
    const {
      model: sessionModel,
      thinkingLevel,
      thinkingBudgets,
    } = prepareRequestedThinkingLevel(model, requestedThinkingLevel);

    // Load the heavy Pi SDK value surface here (not at module top) so the
    // ~200ms `@earendil-works/pi-coding-agent` eval stays off the runtime's
    // pre-session boot path. ESM caches the module, so when the container
    // entrypoint has already warmed it during provisioning this await resolves
    // instantly.
    const {
      createAgentSession,
      DefaultResourceLoader,
      ModelRuntime,
      SessionManager,
      SettingsManager,
    } = await loadPiCodingAgentSdk();

    const modelRuntime = await ModelRuntime.create({
      authPath: this.opts.authStoragePath ?? "/tmp/pi-auth/auth.json",
      modelsPath: null,
      allowModelNetwork: false,
    });
    if (apiKey) {
      // `model.provider` is the Pi SDK's credential key the SDK resolves
      // credentials against; register the key under the same value.
      await setPiRuntimeCredential(modelRuntime, model.provider, apiKey);
    } else {
      // No runtime key — the SDK will call the provider unauthenticated and
      // 401/retry silently (the platform's kickoff fail-fast should prevent
      // this, so reaching here means a run bypassed that guard). Surface a
      // line on the surprising path.
      // runner-pi intentionally avoids a logger dep — same JSON-line-on-stderr
      // convention as the compaction-wait + sink-heartbeat paths.
      process.stderr.write(
        `${JSON.stringify({
          level: "warn",
          msg: "[pi-runner] no API key for model — provider calls will be unauthenticated",
          provider: model.provider,
        })}\n`,
      );
    }

    // ONE call, so the window stamped on every turn breadcrumb cannot drift
    // from the one that sized this session's compaction pass.
    const budget = derivePiCompactionSettings(model, process.env);

    const temperatureExtension: ExtensionFactory[] =
      this.opts.temperature === undefined
        ? []
        : [
            (pi) => {
              pi.on("before_provider_request", (event) => {
                if (!event.payload || typeof event.payload !== "object") return undefined;
                return { ...event.payload, temperature: this.opts.temperature };
              });
            },
          ];
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      extensionFactories: [...(this.opts.extensionFactories ?? []), ...temperatureExtension],
      noExtensions: (this.opts.extensionFactories ?? []).length + temperatureExtension.length === 0,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model: sessionModel,
      thinkingLevel,
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        compaction: budget.compaction,
        thinkingBudgets,
        transport: this.opts.transport ?? "auto",
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

    // Widen the tool set BEFORE the first prompt — see {@link enableSearchTools}
    // for why this placement is the cheap one.
    enableSearchTools(session);

    const terminalTools = this.opts.terminalTools ?? [];
    const bridge = installSessionBridge(session, internalSink, context.runId, {
      terminalTools,
      contextWindow: budget.contextWindow,
      ...(this.opts.unpriced ? { unpriced: true } : {}),
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
    const raceAbort = abortPromise
      ? <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, abortPromise])
      : <T>(promise: Promise<T>): Promise<T> => promise;

    // Mid-run wall-clock steering (#1029). The agent has no clock: the budget is
    // stated once in the turn-1 system prompt and never again, so it over-explores
    // and the watchdog kills it at 100% with nothing delivered.
    //
    // Timing asymmetry, stated rather than left implicit: the watchdog in `run()`
    // counts from ITS `runStart`, while these checkpoints only start counting
    // here, after session construction (SDK eval, auth storage, resource loader,
    // MCP-backed extensions) — call that delta D. Each nudge therefore fires D
    // late and advertises D seconds more runway than the watchdog will actually
    // grant. Accepted, not ignored: D is bounded by session construction (sub-
    // second on a warm SDK, a couple of seconds cold) against budgets of minutes,
    // so the figure is honest at the granularity the agent plans in, and closing
    // the gap would mean threading `runStart` through a protected method that
    // exists to be overridden. Revisit if D ever becomes a visible share of a
    // real budget.
    const cancelDeadlineNudges = scheduleDeadlineNudges({
      timeoutSeconds: context.timeoutSeconds ?? 0,
      steer: (text) => session.steer(text),
      emit: (event) => internalSink.emit(event),
      runId: context.runId,
    });
    try {
      await raceAbort(session.prompt(startMessage ?? systemPrompt));
    } finally {
      // Stand the nudges down the moment the loop settles — before the
      // missing-`output` re-prompt below, so a checkpoint firing during that
      // corrective turn cannot compete with it for the agent's attention.
      cancelDeadlineNudges();
    }

    // The agent loop settled on its own. When the agent owed a structured
    // `output` and never delivered one, this is the LAST moment its context
    // still exists — give it exactly one nudge before the platform's
    // finalize-time validation turns a fully-paid run into a failure.
    await maybeRepromptForOutput({
      session,
      bridge,
      terminalTools,
      sink: internalSink,
      runId: context.runId,
      signal,
      race: raceAbort,
    });

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

// ─── Missing-`output` re-prompt ────────────────────────────────────

/**
 * The terminal tool whose absence is worth one extra turn. Only `output`
 * qualifies: it is the ONLY tool whose omission makes the platform fail an
 * otherwise-successful run at finalize (`services/run-event-ingestion.ts` —
 * "Agent finished without calling the required `output` tool").
 */
const OUTPUT_TERMINAL_TOOL = "output";

/**
 * `run_logs` event name carried in the re-prompt breadcrumb's `data`, so
 * operators can measure output-contract drift
 * (`SELECT count(*) FROM run_logs WHERE data->>'event' = 'output_reprompt'`).
 */
const OUTPUT_REPROMPT_EVENT = "output_reprompt";

/**
 * The only tools the corrective turn may use.
 *
 * `output` is the point of the turn. `read` is there because the findings may
 * no longer be in context: this platform tells agents a deliverable belongs in
 * the run's `outputs/` directory (`@appstrate/core/run-and-wait-client`), and
 * Pi auto-compaction (on unless `MODEL_COMPACTION_ENABLED=false`, see
 * {@link derivePiCompactionSettings}) can summarise the detailed history away
 * before the loop settles — leaving a model whose report is on disk but not in
 * context to fabricate the required fields. `read` recovers work already done
 * and already paid for; it is not research.
 *
 * Everything else stays out: no `bash`, no `edit`/`write`, no
 * `publish_file`, no memory write, no integration tool.
 */
const OUTPUT_REPROMPT_TOOLS = [OUTPUT_TERMINAL_TOOL, "read"];

/** Model-facing text for the corrective turn — must match {@link OUTPUT_REPROMPT_TOOLS}. */
const OUTPUT_REPROMPT_INSTRUCTION =
  "You ended your turn without calling the `output` tool. This agent declares an " +
  "output schema, so the run cannot be delivered until `output` is called exactly " +
  "once with all required fields. Call `output` NOW, using only the work you have " +
  "already done in this session. You may use `read` to re-open files you wrote " +
  "yourself (your `outputs/` directory) if their contents are no longer in " +
  "context; do not call any other tool, do not research anything new, and do not " +
  "reply with plain text.";

/**
 * `run_logs` event name carried in the compaction breadcrumb's `data`, so the
 * hidden cost of auto-compaction is queryable rather than inferred
 * (`SELECT count(*), sum((data->>'outputTokens')::int) FROM run_logs WHERE
 * data->>'event' = 'compaction'`). Mirrors the `output_reprompt` /
 * `deadline_nudge` discriminators.
 */
const COMPACTION_EVENT = "compaction";

/** Minimal Pi SDK session surface needed to issue the corrective turn. */
export interface PromptableSession {
  prompt(message: string): Promise<unknown>;
  /**
   * Tools the agent could actually call on its last turn — the same registry
   * lookup {@link PromptableSession.setActiveToolsByName} performs, so it is
   * the honest probe for what a narrowing would resolve.
   */
  getActiveToolNames(): string[];
  /**
   * Narrow the tool set for the next turn. SDK contract (`pi-coding-agent`
   * `core/agent-session.js:562-581`), stated once and relied on by every caller:
   *  - unresolvable names are **silently dropped**, no throw — a list that
   *    resolves to nothing yields a TOOL-LESS turn, so callers must probe with
   *    {@link PromptableSession.getActiveToolNames} rather than trust their own
   *    configuration.
   *  - it also rebuilds `agent.state.systemPrompt` from the resource loader:
   *    the agent's own instructions survive, only the tool section shrinks.
   *  - cost: rewriting both blocks invalidates the Anthropic prompt-cache
   *    prefix (prefix-based over tools → system → messages; breakpoints sit on
   *    the system block and the LAST tool definition — `pi-ai`
   *    `providers/anthropic.js:672,926`), so the next turn re-reads the whole
   *    session at full input price. Accepted: a fabricated or absent `output`
   *    fails the entire run.
   */
  setActiveToolsByName(toolNames: string[]): void;
}

/**
 * Issue AT MOST ONE corrective `output` turn when the agent loop settled
 * without ever calling the terminal `output` tool.
 *
 * Why here and not at finalize: the platform only discovers the missing
 * `output` when it validates the terminal `RunResult`
 * (`services/run-event-ingestion.ts`) — container gone, context destroyed, run
 * fully paid for. The runner is the only place where the session is still
 * alive; the platform-side validation is unchanged and becomes the safety net.
 *
 * Exactly one attempt, never a loop: a model that ignores an explicit
 * instruction to call `output` from work it has already done gets no second
 * hypothesis.
 *
 * The turn is narrowed to {@link OUTPUT_REPROMPT_TOOLS} — the prompt's "no
 * other tool" clause is a request the model may ignore, the tool set is not.
 * Intentional behaviour change: everything that constant excludes becomes
 * uncallable for this turn.
 *
 * Guards (the first four decide the turn; the fifth only shapes the narrowing):
 *  1. `output` is wired as a terminal tool — mirrors `runtime-pi/entrypoint.ts`,
 *     which passes it only when the agent declared the `output` runtime tool.
 *     Without it there is no output contract to enforce.
 *  2. no terminal tool completed — a successful `output` means the run is
 *     already semantically done (and the SDK loop was aborted early).
 *  3. the run was not cancelled / timed out — `signal` is the runner's combined
 *     controller (user cancel + watchdog); a dead run is not resurrected.
 *  4. the last assistant turn is not a terminal failure — a session that ended
 *     on a provider error or abort cannot answer, so the round-trip would only
 *     add cost to an already-failed run.
 *  5. (narrowing only) request just the {@link OUTPUT_REPROMPT_TOOLS} the
 *     registry resolves, per the silent-drop contract on
 *     {@link PromptableSession.setActiveToolsByName}: no `output` → no
 *     narrowing at all (unrestricted beats tool-less); no `read` → `output`
 *     alone.
 *
 * Emits a warn-level `appstrate.progress` breadcrumb carrying
 * `data.event = "output_reprompt"` BEFORE the retry — the channel every other
 * runner-side lifecycle signal uses (`runtime-ready.ts`), so drift is
 * measurable in `run_logs` without a second reporting path. Sink failures are
 * swallowed: losing the breadcrumb must never cost the run its turn.
 *
 * Exported for unit testing; the production caller is `PiRunner.executeSession`.
 *
 * @returns `true` when the corrective turn was issued, `false` when a guard
 *   declined it.
 * @internal
 */
export async function maybeRepromptForOutput(opts: {
  session: PromptableSession;
  bridge: SessionBridgeHandle;
  terminalTools: string[];
  sink: InternalSink;
  runId: string;
  signal?: AbortSignal;
  /** Races the corrective prompt against the run's abort signal. Identity by default. */
  race?: <T>(promise: Promise<T>) => Promise<T>;
  /** Clock override for tests. */
  now?: () => number;
}): Promise<boolean> {
  const { session, bridge, terminalTools, sink, runId, signal } = opts;
  if (!terminalTools.includes(OUTPUT_TERMINAL_TOOL)) return false;
  if (bridge.terminalToolCompleted) return false;
  if (signal?.aborted) return false;
  if (bridge.getTerminalError() !== undefined) return false;

  await sink
    .emit({
      type: "appstrate.progress",
      timestamp: (opts.now ?? Date.now)(),
      runId,
      message:
        "Agent finished without calling `output` — re-prompting once before the run is failed",
      data: { event: OUTPUT_REPROMPT_EVENT },
      level: "warn",
    })
    .catch(() => {});

  // Make the "call `output`, nothing else" contract mechanical — prompt text
  // alone left the whole tool surface live. Filtered through the registry
  // probe, never `terminalTools` (runner config, not SDK truth).
  const resolvable = new Set(session.getActiveToolNames());
  if (resolvable.has(OUTPUT_TERMINAL_TOOL)) {
    session.setActiveToolsByName(OUTPUT_REPROMPT_TOOLS.filter((name) => resolvable.has(name)));
  }

  const race = opts.race ?? (<T>(promise: Promise<T>): Promise<T> => promise);
  await race(session.prompt(OUTPUT_REPROMPT_INSTRUCTION));
  return true;
}

// ─── Search-tool widening ──────────────────────────────────────────

/**
 * Read-only search tools the Pi SDK ships but does not activate.
 *
 * The SDK registry knows seven built-ins (`core/tools/index.js` →
 * `allToolNames = ["read","bash","edit","write","grep","find","ls"]`) but
 * `createAgentSession` activates only the first four (`core/sdk.js` →
 * `defaultActiveToolNames`). With no `grep`/`find`/`ls` on the surface the model
 * reaches for `bash` for every lookup: in the run that motivated #1029, 101 of
 * 135 tool calls were `bash`, overwhelmingly `grep -rn …` and `sed -n 'A,Bp'`.
 * Each of those pays a shell round-trip and returns unstructured output the
 * model then has to parse.
 *
 * Exported so a test can assert the list rather than restate it.
 */
export const SEARCH_TOOL_NAMES = ["grep", "find", "ls"] as const;

/**
 * Minimal session surface needed to widen the active tool set. Structural (not
 * the SDK's `ToolInfo`) for the same reason {@link BridgeableSession} and
 * {@link PromptableSession} are: the runner's own session contracts stay
 * vendor-type-free, and `ToolInfo` is `Pick<ToolDefinition, "name" | …>` so a
 * real session satisfies this by construction.
 */
export interface ToolWideningSession {
  getActiveToolNames(): string[];
  /** Everything the SDK tool registry resolves — built-ins, extensions, MCP tools. */
  getAllTools(): Array<{ name: string }>;
  setActiveToolsByName(toolNames: string[]): void;
}

/**
 * Add {@link SEARCH_TOOL_NAMES} to the session's active tools, additively.
 *
 * NOT via `createAgentSession({ tools })`: that option is an ALLOWLIST
 * (`core/sdk.js` → `allowedToolNames`) applied to extension and custom tools
 * too, so passing the search-tool list there would silently strip every
 * Appstrate MCP / integration tool off the surface. `setActiveToolsByName` is
 * the additive door.
 *
 * Two consequences of the {@link PromptableSession.setActiveToolsByName}
 * contract shape this function:
 *  - it REPLACES the active set, so the currently-active names (where the
 *    extension / MCP / runtime tools live) must be carried over verbatim. The
 *    post-condition is a superset, never a smaller surface.
 *  - unresolvable names are silently dropped, so each search tool is admitted
 *    only if the registry actually exposes it (`getAllTools()`). A registry
 *    without `find` yields `grep` + `ls` and no phantom name.
 *
 * Called BEFORE the first `session.prompt(...)`, where the rewrite is free: the
 * Anthropic prompt-cache prefix is built by the first request, so there is no
 * cached prefix yet to invalidate. This is the opposite situation to the
 * mid-session narrowing {@link PromptableSession.setActiveToolsByName} warns
 * about — do not read that cost note as applying here.
 *
 * Exported for unit testing; the production caller is `PiRunner.executeSession`.
 *
 * @internal
 */
export function enableSearchTools(session: ToolWideningSession): void {
  const registered = new Set(session.getAllTools().map((tool) => tool.name));
  const widened = new Set(session.getActiveToolNames());
  const activeCount = widened.size;
  for (const name of SEARCH_TOOL_NAMES) {
    if (registered.has(name)) widened.add(name);
  }
  if (widened.size === activeCount) return; // nothing to add — skip the system-prompt rebuild
  session.setActiveToolsByName([...widened]);
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
      // a logger dep, so the existing JSON-line-on-stderr convention
      // from sink-heartbeat applies.
      process.stderr.write(
        `${JSON.stringify({
          level: "warn",
          msg: "[pi-runner] compaction wait timed out",
          timeoutMs,
        })}\n`,
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
  /**
   * True once one of the configured {@link SessionBridgeOptions.terminalTools}
   * has executed successfully — i.e. the run is semantically complete. Read-only
   * live view (a getter, not a snapshot copied at handle-creation time).
   *
   * `PiRunner.executeSession` reads it after the agent loop settles to decide
   * whether the agent still owes an `output` call
   * ({@link maybeRepromptForOutput}).
   */
  readonly terminalToolCompleted: boolean;
  /** Snapshot of token usage accumulated across the session so far. */
  getUsage(): TokenUsage;
  /**
   * Snapshot of total LLM cost in USD accumulated so far, or `undefined` on an
   * {@link SessionBridgeOptions.unpriced} session (the total is placeholder zeros).
   */
  getCost(): number | undefined;
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
 *   - `message_start`  (assistant_message)     → (turn-start clock only, no event)
 *   - `message_end`    (assistant_message)     → `appstrate.progress`
 *   - `message_end`    (turn usage deltas)     → `appstrate.progress` + data { event: "turn", … }
 *   - `message_end`    (stopReason=error)      → `appstrate.error`
 *   - `tool_execution_start`                   → `appstrate.progress` + data { tool, args }
 *   - `tool_execution_end`                     → `appstrate.progress` + data { tool, result, isError, durationMs? }
 *   - `compaction_end` (summarisation usage)   → `appstrate.progress` + data { event: "compaction", … } + `appstrate.metric`
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

/**
 * Project Pi's legacy `{ input, output, cacheRead, cacheWrite }` counters onto
 * the canonical snake_case {@link TokenUsage}, so every downstream emit — and
 * the platform's server-side cost recompute — reads the same four numbers.
 *
 * Exported for `apps/api/test/unit/runner-cost-parity.test.ts`, which pins that
 * recompute against pi-ai's own `calculateCost`. The two cache buckets are
 * priced an order of magnitude apart (3.75 vs 0.30 USD/Mtok at Claude-class
 * rates), so crossing them here re-prices every platform run — and a parity
 * test carrying its own copy of this mapping would agree with itself either
 * way. NOT re-exported from `index.ts`: nothing outside this package imports
 * it, and the barrel there lists only what does.
 */
export function toReportedUsage(usage: PiUsage): TokenUsage {
  return {
    input_tokens: usage.input ?? 0,
    output_tokens: usage.output ?? 0,
    cache_creation_input_tokens: usage.cacheWrite ?? 0,
    cache_read_input_tokens: usage.cacheRead ?? 0,
  };
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
interface PiMessageStartEvent {
  type: "message_start";
  /**
   * The message the SDK is about to stream. `role` discriminates the
   * assistant's own turn from the user / toolResult messages the agent loop
   * also frames with `message_start` (verified in
   * `@earendil-works/pi-agent-core/dist/agent-loop.js`).
   */
  message?: { role?: string };
}
interface PiToolExecutionStartEvent {
  type: "tool_execution_start";
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
}
/**
 * Auto-compaction settled. Its `usage` is the summarisation LLM call — real
 * spend the run must account for, and the only paid call in a LINEAR Pi
 * session that never appears as an assistant `message_end`: it is written to a
 * dedicated `compaction` session entry instead (`agent-session.js` →
 * `appendCompaction`). Pi's own `getSessionStats()` counts one sibling,
 * `branch_summary`, which no Appstrate path can produce — branch
 * summarisation runs only on an explicit tree/branch operation, and both the
 * runner and the chat drive a single linear session.
 */
interface PiCompactionResult {
  /** Optional on the vendor too: an extension-supplied summary may report none. */
  usage?: PiUsage;
  tokensBefore: number;
  estimatedTokensAfter?: number;
}
interface PiCompactionEndEvent {
  type: "compaction_end";
  reason: string;
  aborted: boolean;
  /** Key always present; `undefined` when the pass was aborted or failed. */
  result: PiCompactionResult | undefined;
}
/**
 * Compile-time pin: Pi's own `compaction_end` variant must still satisfy
 * everything {@link installSessionBridge} reads off it. The bridge subscribes
 * with an untyped callback (the SDK value graph stays behind
 * `loadPiCodingAgentSdk()`), so nothing else would catch a renamed field —
 * and a miss here is silent under-accounting, not a crash. Type-only, erased
 * at runtime. Same idiom as `_assertApiShapeSubsetOfPi` above.
 *
 * TWO assertions, because assignability alone is not enough. A structural
 * check only bites on REQUIRED members: a vendor object that dropped or
 * renamed an OPTIONAL field still satisfies a view that declares it optional.
 * `usage` — the whole reason this event is handled — is optional on both
 * sides, so its key is pinned by name separately.
 */
type VendorCompactionEnd = Extract<PiSdkAgentSessionEvent, { type: "compaction_end" }>;
type VendorCompactionResult = NonNullable<VendorCompactionEnd["result"]>;

type Conforms<Vendor, Ours> = [Vendor] extends [Ours]
  ? true
  : { error: "Pi's compaction_end no longer fits the bridge's view"; vendor: Vendor; ours: Ours };

type HasKey<T, K extends string> = K extends keyof T
  ? true
  : { error: "Pi's CompactionResult no longer carries this field"; missing: K; vendor: T };

type _CompactionEndConforms = Conforms<VendorCompactionEnd, PiCompactionEndEvent> &
  HasKey<VendorCompactionResult, "usage"> &
  HasKey<VendorCompactionResult, "estimatedTokensAfter">;

const _assertCompactionEndConforms: _CompactionEndConforms = true;
void _assertCompactionEndConforms;

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
export { truncateToolResult };

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

/**
 * Some provider adapters normalize an AbortError into stopReason "error"
 * instead of "aborted". Keep this deliberately narrow: it is only consulted
 * after a terminal tool completed successfully.
 */
function isProviderNormalizedAbort(errorMessage: string | undefined): boolean {
  if (typeof errorMessage !== "string") return false;
  const trimmed = errorMessage.trim();
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 46) end -= 1;
  const normalized = trimmed.slice(0, end).toLowerCase();
  return normalized === "the operation was aborted" || normalized === "this operation was aborted";
}

interface SessionBridgeOptions {
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
  /**
   * Context window (tokens) the session actually runs against, straight off
   * {@link derivePiCompactionSettings}, stamped on every turn breadcrumb so the
   * gauge's denominator travels with its numerator. Omit it when it is not
   * knowable — a caller that installs the bridge without an SDK session behind
   * it.
   */
  contextWindow?: number;
  /** No rates back this session's model — see {@link PiRunnerOptions.unpriced}. */
  unpriced?: boolean;
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
  // assistant turn, which must NOT be read as a terminal failure. Exposed
  // read-only on the handle so `executeSession` can tell "the agent still
  // owes an `output`" from "the run already delivered".
  let terminalToolCompleted = false;
  // Token usage accumulator across every paid call of the session (shared
  // zero-shape) — assistant turns AND compaction passes.
  const totalUsage: TokenUsage = zeroTokenUsage();
  let totalCost = 0;
  // Single place the unpriced decision is applied: every emit path reads through
  // this, so none can leak the placeholder zero. `undefined` omits the field.
  const reportedCost = (): number | undefined => (options.unpriced ? undefined : totalCost);

  /**
   * Fold one Pi `Usage` into the run totals and report its deltas. `cost` is
   * Pi's own (`calculateCost` against the model's rates) — never recomputed.
   */
  const accumulateUsage = (usage: PiUsage): { inputDelta: number; outputDelta: number } => {
    const delta = toReportedUsage(usage);
    const inputDelta = delta.input_tokens ?? 0;
    const outputDelta = delta.output_tokens ?? 0;
    totalUsage.input_tokens = (totalUsage.input_tokens ?? 0) + inputDelta;
    totalUsage.output_tokens = (totalUsage.output_tokens ?? 0) + outputDelta;
    totalUsage.cache_creation_input_tokens =
      (totalUsage.cache_creation_input_tokens ?? 0) + (delta.cache_creation_input_tokens ?? 0);
    totalUsage.cache_read_input_tokens =
      (totalUsage.cache_read_input_tokens ?? 0) + (delta.cache_read_input_tokens ?? 0);
    totalCost += usage.cost?.total ?? 0;
    return { inputDelta, outputDelta };
  };

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

  // Start timestamps of in-flight tool calls, keyed by the SDK's `toolCallId`,
  // so the result event can carry `durationMs` instead of making every operator
  // self-join the start row to the result row. Bounded by concurrency, not by
  // run length: each entry is deleted the moment its result lands. Keyed on
  // `toolCallId` ONLY — a tool-name fallback would cross-attribute a parallel
  // batch of two `bash` calls, which is worse than no timing at all.
  const toolCallStarts = new Map<string, number>();

  // Per-turn context-growth tracking. `settledTurnIndex` counts every settled
  // assistant turn (1-based), so a gap in the emitted breadcrumbs is itself
  // readable as "that turn reported no usage". `assistantTurnStartedAt` is the
  // `message_start` timestamp of the turn currently streaming — consumed and
  // cleared at `message_end` so a turn whose start we never saw cannot inherit
  // the previous turn's clock.
  let settledTurnIndex = 0;
  let assistantTurnStartedAt: number | undefined;

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
      case "message_start": {
        // Pure bookkeeping — emits nothing. The SDK frames user and toolResult
        // messages with `message_start` too, so `role` is the discriminator;
        // without it the "turn latency" would start ticking at the previous
        // tool result rather than at the model call.
        const e = event as PiMessageStartEvent;
        if (e.message?.role === "assistant") assistantTurnStartedAt = Date.now();
        break;
      }

      case "message_end": {
        const entries = session.state.messages;
        if (!entries.length) break;
        const last = entries[entries.length - 1] as PiAssistantMessage | undefined;
        if (last?.role !== "assistant") break;

        const turnIndex = ++settledTurnIndex;
        const latencyMs =
          assistantTurnStartedAt !== undefined ? Date.now() - assistantTurnStartedAt : undefined;
        assistantTurnStartedAt = undefined;

        // Record this assistant turn's terminal outcome. Overwritten each
        // turn → ends as the FINAL assistant turn's stopReason once the
        // loop settles (mirrors the SDK's own `_lastAssistantMessage`).
        lastAssistantStopReason = last.stopReason;
        lastAssistantErrorMessage = last.errorMessage;

        // Accumulate this turn's token usage into the run totals.
        const u = last.usage;
        if (u) {
          const { inputDelta, outputDelta } = accumulateUsage(u);

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
            fire(buildMetric({ runId, timestamp: Date.now() }, { ...totalUsage }, reportedCost()));

            // Per-turn context-growth breadcrumb. Shares the metric's gate on
            // purpose — a turn the SDK reported with no counters has nothing to
            // plot, and two independently-drifting gates would make the
            // breadcrumb trail disagree with the cost curve. Unlike the metric
            // above (cumulative, and written to no `run_logs` row) this carries
            // the turn's OWN deltas and IS persisted, which is the only way an
            // author can see WHERE a run started re-reading 96k tokens a turn.
            // Deliberately ONE row per settled turn — never per chunk: the
            // bridge already refuses to forward `message_update` for exactly
            // that reason (~108 rows on a heavy run, against ~135 tool rows).
            fire(
              buildTurnProgress(
                { runId, timestamp: Date.now() },
                {
                  index: turnIndex,
                  ...(latencyMs !== undefined ? { latencyMs } : {}),
                  inputTokens: inputDelta,
                  outputTokens: outputDelta,
                  cacheReadTokens: u.cacheRead ?? 0,
                  cacheWriteTokens: u.cacheWrite ?? 0,
                  ...(options.contextWindow !== undefined
                    ? { contextWindow: options.contextWindow }
                    : {}),
                },
              ),
            );
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
          !(
            terminalToolCompleted &&
            (last.stopReason === "aborted" || isProviderNormalizedAbort(last.errorMessage))
          )
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

      // Auto-compaction is a real LLM call the run pays for, and the only one
      // that never surfaces as an assistant `message_end` — Pi appends it to a
      // dedicated `compaction` session entry (which is why its own
      // `getSessionStats()` counts it and a message-only accumulator does
      // not). Without this the tokens are invisible to `RunResult.usage` /
      // `.cost`, and on a run with no llm-proxy rows to fall back on (a
      // no-sidecar run against a static key) they are missing from
      // `runs.cost` outright.
      case "compaction_end": {
        const e = event as unknown as PiCompactionEndEvent;
        const usage = e.result?.usage;
        // An aborted or failed pass carries no `result`: nothing was billed.
        if (!usage) break;
        accumulateUsage(usage);

        // Breadcrumb BEFORE the metric: a reader scanning `run_logs` sees the
        // cause next to the cost step it explains — the alternative is a cost
        // curve that jumps for no visible reason, since compaction produces no
        // turn row of its own.
        const before = e.result?.tokensBefore;
        const after = e.result?.estimatedTokensAfter;
        fire({
          type: "appstrate.progress",
          timestamp: Date.now(),
          runId,
          message:
            before !== undefined && after !== undefined
              ? `Context compacted — ${before} → ${after} tokens`
              : "Context compacted",
          data: {
            event: COMPACTION_EVENT,
            ...(e.reason !== undefined ? { reason: e.reason } : {}),
            ...(before !== undefined ? { tokensBefore: before } : {}),
            ...(after !== undefined ? { estimatedTokensAfter: after } : {}),
            inputTokens: usage.input ?? 0,
            outputTokens: usage.output ?? 0,
          },
        });
        fire(buildMetric({ runId, timestamp: Date.now() }, { ...totalUsage }, reportedCost()));
        break;
      }

      case "tool_execution_start": {
        const e = event as PiToolExecutionStartEvent;
        // `toolCallId` is the Pi SDK's per-call identifier; forwarding it lets
        // sinks correlate start/end events when multiple tools run concurrently
        // (the LLM can dispatch a parallel batch and the results land
        // out-of-order). Optional — omitted from `data` when the SDK gave none.
        if (e.toolCallId !== undefined) toolCallStarts.set(e.toolCallId, Date.now());
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
        // Stamp the call's wall time when we saw its start. `delete` keeps the
        // map bounded by in-flight calls; a result with no id, or one whose
        // start we never observed, yields no `durationMs` at all — omission is
        // honest, a zero would read as an instant call.
        const startedAt = e.toolCallId !== undefined ? toolCallStarts.get(e.toolCallId) : undefined;
        if (e.toolCallId !== undefined) toolCallStarts.delete(e.toolCallId);
        fire(
          buildToolResultProgress(
            { runId, timestamp: Date.now() },
            {
              tool,
              result: truncateToolResult(e.result),
              isError: e.isError === true,
              ...(e.toolCallId !== undefined ? { toolCallId: e.toolCallId } : {}),
              ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {}),
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
        fire(buildMetric({ runId, timestamp: Date.now() }, { ...totalUsage }, reportedCost()));
        break;
      }

      default:
        break;
    }
  });

  return {
    get terminalToolCompleted(): boolean {
      return terminalToolCompleted;
    },
    getUsage(): TokenUsage {
      return { ...totalUsage };
    },
    getCost(): number | undefined {
      return reportedCost();
    },
    getTerminalError(): RunError | undefined {
      // Verdict on the LAST assistant turn. `isTerminalErrorStop` /
      // `terminalErrorMessage` are shared with the live `appstrate.error`
      // emit above, so the stamped status and the `run_logs` trail can
      // never disagree on what counts as a terminal failure.
      // A trailing "aborted" turn AFTER a successful terminal tool is the
      // runner's own early-stop, not a failure.
      if (
        terminalToolCompleted &&
        (lastAssistantStopReason === "aborted" ||
          isProviderNormalizedAbort(lastAssistantErrorMessage))
      ) {
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
