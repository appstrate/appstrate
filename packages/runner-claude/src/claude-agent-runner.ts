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
  reduceEvents,
  type RunOptions,
  type Runner,
  type RunResult,
} from "@appstrate/afps-runtime/runner";
import { buildClaudeSdkEnv } from "./claude-binary.ts";
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
  /** Upper bound on agent turns. Defaults to {@link DEFAULT_MAX_TURNS}. */
  maxTurns?: number;
  /** Enable the SDK's native Bash/Edit/Read/Write tools. Defaults to `true`. */
  enableNativeTools?: boolean;
  /** Kickoff user message. Defaults to the run input, else a generic trigger. */
  startMessage?: string;
  /** Extra curated env merged into the spawned binary's environment. */
  env?: Record<string, string>;
  /** Injectable Agent SDK driver. Defaults to the real `query()` (lazy-loaded). */
  query?: ClaudeQueryFn;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/** Upper bound on agent turns per run (autonomous loop). */
const DEFAULT_MAX_TURNS = 100;

function resolveStartMessage(context: ExecutionContext, explicit: string | undefined): string {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  if (typeof context.input === "string" && context.input.trim().length > 0) return context.input;
  if (context.input != null) {
    try {
      return JSON.stringify(context.input);
    } catch {
      /* fall through */
    }
  }
  return "Begin the task according to your instructions.";
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

    const queryOptions: Record<string, unknown> = {
      pathToClaudeCodeExecutable: this.opts.binaryPath,
      env: buildClaudeSdkEnv({
        baseUrl: this.opts.baseUrl,
        placeholderToken: this.opts.placeholderToken,
        ...(this.opts.env ? { extra: this.opts.env } : {}),
      }),
      model: this.opts.modelId,
      systemPrompt: this.opts.systemPrompt,
      cwd: this.opts.cwd,
      // Native Bash/Edit/Read/Write on by default (full agent fidelity in the
      // sandbox); `tools: []` only when a caller explicitly opts out.
      ...(this.opts.enableNativeTools === false ? { tools: [] } : {}),
      mcpServers,
      ...(this.opts.outputSchema
        ? { outputFormat: { type: "json_schema", schema: this.opts.outputSchema } }
        : {}),
      permissionMode: "bypassPermissions",
      settingSources: [],
      persistSession: false,
      maxTurns: this.opts.maxTurns ?? DEFAULT_MAX_TURNS,
      abortController: controller,
    };

    const query = await this.resolveQuery();

    try {
      const stream = query({
        prompt: resolveStartMessage(context, this.opts.startMessage),
        options: queryOptions,
      });
      for await (const msg of stream) {
        for (const event of mapper.map(msg)) await emit(event);
        // Drain journaled runtime events at this message boundary (single sink →
        // sequence intact). The SDK awaits each tool's completion before the
        // next message, so by the time we drain the tool's events are journaled.
        await drainAndEmit();
      }
    } catch (err) {
      if (signal?.aborted) {
        // Cancellation: propagate without finalizing — the caller's finally
        // block decides (mirrors PiRunner).
        throw err;
      }
      const message = getErrorMessage(err);
      await emit({ type: "appstrate.error", timestamp: now(), runId, message });
      // Best-effort final drain: capture any runtime events journaled before the
      // SDK stream threw (log/note/pin/report the agent produced mid-run).
      await drainAndEmit(true);
      const result = reduceEvents(events, {
        error: { message, stack: err instanceof Error ? err.stack : undefined },
      });
      // Explicit, runner-authoritative verdict (the reducer leaves `status`
      // absent — consumers would default it, but a thrown SDK stream is
      // unambiguously a failure).
      result.status = "failed";
      // Stamp the tokens already spent before the throw (the SDK never emitted
      // its authoritative `result`, so without this they'd be lost as zero).
      result.usage = mapper.liveUsageSnapshot();
      await eventSink.finalize(result);
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
