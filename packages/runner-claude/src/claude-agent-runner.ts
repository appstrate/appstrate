// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * ClaudeAgentRunner — AFPS {@link Runner} backed by the official
 * `@anthropic-ai/claude-agent-sdk`.
 *
 * The official-binary (no-forging) counterpart of the Pi runner for
 * `claude-code` (Claude subscription) runs. It drives the Agent SDK `query()` IN-PROCESS under Bun
 * (via the prebuilt native binary — `./claude-binary.ts`), pointed
 * at the sidecar's non-forging credential-injection gateway
 * (`ANTHROPIC_BASE_URL`). Unlike the Pi path, NOTHING here forges the Claude
 * Code fingerprint — the official binary signs its own identity, which is the
 * whole point of the migration.
 *
 * Tool surface:
 *   - structured deliverable → native SDK `outputFormat` → `structured_output`
 *     (`OUTPUT_NATIVE_OK`); re-emitted here as one `output.emitted` event so the
 *     reducer populates `RunResult.output`.
 *   - runtime tools (log/note/pin/report) → served by the sidecar `/mcp` like
 *     every other tool; the sidecar executes each ONCE and journals its
 *     canonical events. This runner drains the journal (`drainer`) after each
 *     SDK message and re-emits on the run's single sink — the SDK's HTTP MCP
 *     client drops the result `_meta` the events would ride in (`META_DROPPED`),
 *     so the journal is the only source. Same drain path as the Pi + Codex runners.
 *   - integrations / api_call / run_history / recall_memory → sidecar `/mcp`
 *     over HTTP (tool result `content` survives; only `_meta` is dropped).
 *   - native Bash/Edit/Read/Write → enabled by default (full fidelity in the
 *     sandboxed container; the container has no creds and egresses only through
 *     the sidecar proxy — same isolation as the Pi path).
 *
 * Terminal status/usage/cost are runner-authoritative, taken from the SDK
 * `result` message (mirrors PiRunner reading the last assistant turn).
 */

import type { RunEvent, ExecutionContext } from "@appstrate/afps-runtime/types";
import {
  emptyRunResult,
  finalizeThrownFailure,
  reduceEvents,
  runInputToText,
  type RunOptions,
  type Runner,
  type RunResult,
} from "@appstrate/afps-runtime/runner";
import { buildClaudeSdkEnv, CLAUDE_SDK_HARDENING } from "./claude-binary.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { drainAndEmitInto, type RuntimeEventDrainer } from "@appstrate/core/runtime-event-drain";
import { SdkRunEventMapper, type SdkRunMessage } from "./sdk-event-mapper.ts";

/** Input to the injectable `query` driver — the subset of the SDK call we issue. */
export interface ClaudeQueryInput {
  prompt: string;
  options: Record<string, unknown>;
}
/** The Agent SDK's `query()`, narrowed to what the runner needs (injectable for tests). */
export type ClaudeQueryFn = (input: ClaudeQueryInput) => AsyncIterable<SdkRunMessage>;

export interface ClaudeAgentRunnerOptions {
  /** Absolute path to the prebuilt `claude` binary (`./claude-binary.ts`). */
  binaryPath: string;
  /** Real upstream model id (e.g. `claude-haiku-4-5`) — NOT the platform model label. */
  modelId: string;
  /** Enriched platform system prompt (the agent persona + host context). */
  systemPrompt: string;
  /** `ANTHROPIC_BASE_URL` — the sidecar `/llm` oauth gateway (non-forging). */
  baseUrl: string;
  /** Placeholder bearer the SDK sends; the gateway swaps it for the real token. */
  placeholderToken: string;
  /** Working directory for the SDK's native file/exec tools (the run workspace). */
  cwd: string;
  /**
   * Runtime-event drainer (`@appstrate/core/runtime-event-drain`). The sidecar
   * executes each runtime tool (log/note/pin/report) ONCE and journals its
   * canonical events; this runner drains them after each SDK message (the SDK's
   * HTTP MCP client drops the result `_meta` the events would otherwise ride in
   * — `META_DROPPED`) and re-emits on the run's single sink. `output` is NOT in
   * the journal — Claude takes the structured deliverable natively (see below).
   * Omit when the run has no runtime tools.
   */
  drainer?: RuntimeEventDrainer;
  /** Output JSON Schema → SDK `outputFormat`; absent leaves the run output-less. */
  outputSchema?: Record<string, unknown> | null;
  /** Sidecar `/mcp` (integrations, api_call, run_history, recall_memory). */
  sidecarMcp?: { url: string; headers?: Record<string, string> };
  /** Injectable Agent SDK driver. Defaults to the real `query()` (lazy-loaded). */
  query?: ClaudeQueryFn;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /**
   * Idle-stall watchdog: max ms with no SDK stream message before the run is
   * aborted as a failure. Defaults to {@link DEFAULT_IDLE_TIMEOUT_MS}; `0` or a
   * negative value disables it. Catches the silent hang when the claude-code
   * binary retries an upstream 429 (plan / rate limit) up to 10× in the
   * background without ever emitting a message — without this the only backstop
   * is the platform's 300s container watchdog, which can only ever produce a
   * `timeout` status (never an actionable `failed` + rate-limit message).
   */
  idleTimeoutMs?: number;
}

/** Upper bound on agent turns per run (autonomous loop). */
const DEFAULT_MAX_TURNS = 100;

/**
 * Default idle-stall watchdog window. Picked to sit comfortably below the
 * platform's 300s container watchdog (so a stall surfaces as a `failed` run
 * with an explicit message instead of a SIGKILL-induced `timeout`) while
 * staying well above any legitimate gap between SDK stream messages — note a
 * long native tool call (e.g. a heavy Bash build) produces no intermediate
 * message, so this must not be set too tight.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

function resolveStartMessage(context: ExecutionContext): string {
  // Shared string|null|JSON.stringify normalisation; the fallback sentence
  // stays owned here (the helper returns "" for empty input).
  return runInputToText(context.input) || "Begin the task according to your instructions.";
}

export class ClaudeAgentRunner implements Runner {
  readonly name = "claude-agent-runner";

  private readonly opts: ClaudeAgentRunnerOptions;

  constructor(opts: ClaudeAgentRunnerOptions) {
    this.opts = opts;
  }

  /** Lazily resolve the real SDK `query` only when no driver was injected. */
  private async resolveQuery(): Promise<ClaudeQueryFn> {
    if (this.opts.query) return this.opts.query;
    let query: typeof import("@anthropic-ai/claude-agent-sdk").query;
    try {
      ({ query } = await import("@anthropic-ai/claude-agent-sdk"));
    } catch (err) {
      // The SDK is a runtime dep of the claude runner image; a resolution
      // failure here means the image was built wrong. Surface it explicitly
      // instead of leaking a raw module-not-found at first run().
      throw new Error(
        `claude-agent-runner: @anthropic-ai/claude-agent-sdk is not available (${getErrorMessage(err)})`,
      );
    }
    return (input) =>
      query({
        prompt: input.prompt,
        options: input.options as never,
      }) as AsyncIterable<SdkRunMessage>;
  }

  async run(options: RunOptions): Promise<void> {
    const { context, eventSink, signal } = options;
    signal?.throwIfAborted();

    const runId = context.runId;
    const now = this.opts.now ?? Date.now;
    const events: RunEvent[] = [];
    const emit = async (event: RunEvent): Promise<void> => {
      events.push(event);
      await eventSink.handle(event);
    };

    const mapper = new SdkRunEventMapper(runId, now);

    // Runtime tools (log/note/pin/report) are executed ONCE by the sidecar,
    // which journals their canonical events. Drain the journal after each SDK
    // message and re-emit on the run's single sink — the SDK's HTTP MCP client
    // drops the result `_meta` those events would otherwise ride in
    // (`META_DROPPED`), so the events come exclusively from the journal. A drain
    // is cheap on localhost and a no-op when empty. `output` is NOT journaled:
    // Claude takes the structured deliverable natively off
    // `result.structured_output` via `outputFormat` (constrained decoding), and
    // is re-emitted once below — it must not double-emit. No-op when no drainer.
    const drainer = this.opts.drainer;
    // Shared drain+stamp+emit (see `@appstrate/core/runtime-event-drain`): one
    // cadence + best-effort-at-finalize contract for all three runners, so it
    // cannot drift between them.
    const drainAndEmit = (final = false): Promise<void> =>
      drainAndEmitInto({ drainer, emit: (e) => emit(e as RunEvent), now, runId, final });

    const mcpServers: Record<string, unknown> = {};
    if (this.opts.sidecarMcp) {
      mcpServers.appstrate = {
        type: "http",
        url: this.opts.sidecarMcp.url,
        headers: this.opts.sidecarMcp.headers ?? {},
      };
    }

    // Cancellation: bridge the AFPS signal to the SDK's AbortController.
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }

    // Idle-stall watchdog. Aborts the SDK's OWN controller (never the AFPS
    // `signal`) on prolonged silence: that keeps `signal.aborted === false`, so
    // `finalizeThrownFailure` runs its full epilogue (status="failed" + explicit
    // error) instead of its abort-rethrow arm reserved for real cancellation.
    // Re-armed on every stream message; cleared once a message arrives and in
    // every exit path so the timer can't outlive the run.
    const idleMs = this.opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idleAborted = false;
    const clearIdle = (): void => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    const armIdle = (): void => {
      if (idleMs <= 0) return;
      clearIdle();
      idleTimer = setTimeout(() => {
        idleAborted = true;
        controller.abort(new Error("claude-agent-runner: idle-stall watchdog"));
      }, idleMs);
    };

    const queryOptions: Record<string, unknown> = {
      pathToClaudeCodeExecutable: this.opts.binaryPath,
      env: buildClaudeSdkEnv({
        baseUrl: this.opts.baseUrl,
        placeholderToken: this.opts.placeholderToken,
      }),
      model: this.opts.modelId,
      systemPrompt: this.opts.systemPrompt,
      cwd: this.opts.cwd,
      // Native Bash/Edit/Read/Write always on (full agent fidelity in the sandbox).
      mcpServers,
      ...(this.opts.outputSchema
        ? { outputFormat: { type: "json_schema", schema: this.opts.outputSchema } }
        : {}),
      ...CLAUDE_SDK_HARDENING,
      maxTurns: DEFAULT_MAX_TURNS,
      abortController: controller,
    };

    const query = await this.resolveQuery();

    try {
      const stream = query({
        prompt: resolveStartMessage(context),
        options: queryOptions,
      });
      armIdle();
      for await (const msg of stream) {
        clearIdle(); // the model is responsive — stand the watchdog down
        for (const event of mapper.map(msg)) await emit(event);
        // Drain journaled runtime events at this message boundary (single sink →
        // sequence intact). The SDK awaits each tool's completion before the
        // next message, so by the time we drain the tool's events are journaled.
        await drainAndEmit();
        armIdle(); // re-arm for the gap before the next message
      }
      clearIdle();
    } catch (err) {
      clearIdle();
      // A watchdog-fired abort throws an opaque SDK AbortError; translate it
      // into an explicit, actionable failure. Gated on `!signal.aborted` so a
      // real cancellation that raced the watchdog still flows through the
      // epilogue's abort-rethrow arm untouched.
      const failure =
        idleAborted && !signal?.aborted
          ? new Error(
              `claude-agent-runner: no agent activity for ${Math.round(idleMs / 1000)}s — ` +
                "the model was unreachable (likely a Claude plan / rate limit)",
            )
          : err;
      // Shared thrown-failure epilogue (abort-rethrow → emit appstrate.error →
      // best-effort final drain → reduce → status="failed" → stamp usage →
      // finalize). No redaction needed — the Claude path holds no in-run
      // credential at rest (the sidecar gateway swaps the placeholder token in
      // flight), so the transform stays identity.
      await finalizeThrownFailure({
        events,
        err: failure,
        signal,
        runId,
        now,
        emit,
        drainAndEmit: () => drainAndEmit(true),
        eventSink,
        // Stamp the tokens already spent before the throw (the SDK never emitted
        // its authoritative `result`, so without this they'd be lost as zero).
        usage: mapper.liveUsageSnapshot(),
      });
      return;
    }

    // Final drain (drain-until-empty + bounded retry) before finalize — the
    // sidecar is torn down right after, so the last tool's journaled events must
    // be pulled now.
    await drainAndEmit(true);

    const terminal = mapper.terminal();

    // Native structured deliverable → one `output.emitted` so the reducer sets
    // RunResult.output (no `output` runtime tool is involved on this path).
    // Best-effort emit, like the final drain above: `emit` pushes onto `events`
    // BEFORE awaiting the sink, so `reduceEvents` + the finalize POST already
    // carry the output; a dead sink here must not throw out and flip an
    // otherwise-succeeded run to failed (a truly dead sink surfaces at finalize).
    if (terminal?.structuredOutput !== undefined) {
      try {
        await emit({
          type: "output.emitted",
          timestamp: now(),
          runId,
          data: terminal.structuredOutput,
        });
      } catch {
        /* swallowed: run outcome decided elsewhere */
      }
    }

    const result: RunResult = events.length === 0 ? emptyRunResult() : reduceEvents(events);
    if (terminal) {
      result.status = terminal.status;
      if (terminal.error) result.error = terminal.error;
      result.usage = terminal.usage;
      result.cost = terminal.cost;
      if (terminal.durationMs !== undefined) result.durationMs = terminal.durationMs;
    } else {
      // The SDK stream ended without a `result` message — no authoritative
      // verdict. Treat as a failure rather than silently reporting success.
      result.status = "failed";
      result.error = result.error ?? {
        code: "no_result",
        message: "The Claude Agent SDK stream ended without a result message",
      };
      // No authoritative usage either — stamp what the assistant turns spent so
      // the run still records the tokens already consumed.
      result.usage = mapper.liveUsageSnapshot();
    }

    await eventSink.finalize(result);
  }
}
