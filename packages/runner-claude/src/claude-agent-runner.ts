// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * ClaudeAgentRunner — AFPS {@link Runner} backed by the official
 * `@anthropic-ai/claude-agent-sdk`.
 *
 * The ToS-clean counterpart of the Pi runner for `claude-code` (Claude
 * subscription) runs. It drives the Agent SDK `query()` IN-PROCESS under Bun
 * (via the prebuilt native binary — `@appstrate/core/claude-binary`), pointed
 * at the sidecar's non-forging credential-injection gateway
 * (`ANTHROPIC_BASE_URL`). Unlike the Pi path, NOTHING here forges the Claude
 * Code fingerprint — the official binary signs its own identity, which is the
 * whole point of the migration.
 *
 * Tool surface (locked by the Phase-0 spikes):
 *   - structured deliverable → native SDK `outputFormat` → `structured_output`
 *     (`OUTPUT_NATIVE_OK`); re-emitted here as one `output.emitted` event so the
 *     reducer populates `RunResult.output`.
 *   - runtime tools (log/note/pin/report) → in-process MCP, handlers emit
 *     RunEvents straight to the sink (`INSTANCE_OK`; `_meta` over HTTP is
 *     dropped — `META_DROPPED`).
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
import { SdkRunEventMapper, type SdkRunMessage } from "./sdk-event-mapper.ts";
import { buildRuntimeToolsMcpServer } from "./runtime-tools-mcp.ts";

/** Input to the injectable `query` driver — the subset of the SDK call we issue. */
export interface ClaudeQueryInput {
  prompt: string;
  options: Record<string, unknown>;
}
/** The Agent SDK's `query()`, narrowed to what the runner needs (injectable for tests). */
export type ClaudeQueryFn = (input: ClaudeQueryInput) => AsyncIterable<SdkRunMessage>;

export interface ClaudeAgentRunnerOptions {
  /** Absolute path to the prebuilt `claude` binary (`@appstrate/core/claude-binary`). */
  binaryPath: string;
  /** Real upstream model id (e.g. `claude-haiku-4-5`) — NOT the platform model label. */
  modelId: string;
  /** Enriched platform system prompt (the agent persona + host context). */
  systemPrompt: string;
  /** `ANTHROPIC_BASE_URL` — the sidecar `/llm` oauth-passthrough gateway. */
  baseUrl: string;
  /** Placeholder bearer the SDK sends; the gateway swaps it for the real token. */
  placeholderToken: string;
  /** Working directory for the SDK's native file/exec tools (the run workspace). */
  cwd: string;
  /** Agent-selected runtime tools (`manifest.runtime_tools`); `output` is native. */
  runtimeTools?: readonly string[];
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

/**
 * Curated environment for the spawned `claude` binary. Mirrors the chat
 * engine's `buildSdkEnv`: never forward the full `process.env` (would leak
 * platform secrets into the subprocess), only the bits the binary needs plus
 * the gateway pointers and the flags that keep it from phoning home or picking
 * up an ambient API key.
 */
export function buildClaudeSdkEnv(opts: {
  baseUrl: string;
  placeholderToken: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  const passthrough = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"];
  const env: Record<string, string> = {};
  for (const key of passthrough) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.ANTHROPIC_BASE_URL = opts.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = opts.placeholderToken;
  // Never let an ambient API key flip the binary onto the API-key path.
  env.ANTHROPIC_API_KEY = "";
  // Keep the subscription binary quiet and non-self-updating in a server.
  env.DISABLE_AUTOUPDATER = "1";
  env.DISABLE_TELEMETRY = "1";
  env.DISABLE_ERROR_REPORTING = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return { ...env, ...(opts.extra ?? {}) };
}

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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
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

    // In-process runtime tools (log/note/pin/report) — handlers emit straight
    // to `emit`, so their events share the run's single ordered stream.
    const runtimeMcp = buildRuntimeToolsMcpServer({
      ...(this.opts.runtimeTools ? { runtimeTools: this.opts.runtimeTools } : {}),
      emit,
    });

    const mcpServers: Record<string, unknown> = {};
    if (runtimeMcp) {
      mcpServers[runtimeMcp.name] = {
        type: "sdk",
        name: runtimeMcp.name,
        instance: runtimeMcp.server,
      };
    }
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
      }
    } catch (err) {
      if (signal?.aborted) {
        // Cancellation: propagate without finalizing — the caller's finally
        // block decides (mirrors PiRunner).
        throw err;
      }
      const message = errorMessage(err);
      await emit({ type: "appstrate.error", timestamp: now(), runId, message });
      const result = reduceEvents(events, {
        error: { message, stack: err instanceof Error ? err.stack : undefined },
      });
      // Explicit, runner-authoritative verdict (the reducer leaves `status`
      // absent — consumers would default it, but a thrown SDK stream is
      // unambiguously a failure).
      result.status = "failed";
      await eventSink.finalize(result);
      return;
    }

    const terminal = mapper.terminal();

    // Native structured deliverable → one `output.emitted` so the reducer sets
    // RunResult.output (no `output` runtime tool is involved on this path).
    if (terminal?.structuredOutput !== undefined) {
      await emit({
        type: "output.emitted",
        timestamp: now(),
        runId,
        data: terminal.structuredOutput,
      });
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
    }

    await eventSink.finalize(result);
  }
}
