// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * CodexAgentRunner — AFPS {@link Runner} backed by the official OpenAI Codex
 * CLI (`codex exec --json`).
 *
 * The ToS-clean counterpart of the Pi runner for `codex` (ChatGPT Plus/Pro/
 * Business subscription) runs, and the agents-axis twin of the chat's
 * `codex-agent` engine. It drives the official `codex` binary as a subprocess —
 * the binary signs its OWN client fingerprint (`originator: codex_exec`) and
 * sends its own `chatgpt-account-id`, so NOTHING is forged.
 *
 * Why a token VEND (not a reverse-proxy gateway like the Claude runner): the
 * Codex CLI's models-manager calls `chatgpt.com` VERBATIM, ignoring
 * `chatgpt_base_url` — the sidecar cannot sit in its request path. So at run
 * start the runner GETs the real subscription token once from the sidecar's
 * internal-network-gated `/credential-vend`, writes it into `CODEX_HOME/auth.json`,
 * and the binary egresses straight to the upstream. The compensating controls
 * for the real token living in-container:
 *   - the sidecar's per-run egress allowlist locks outbound traffic to the
 *     provider's hosts (chatgpt.com / auth.openai.com) — the token cannot be
 *     exfiltrated to an attacker endpoint, and
 *   - the vended access token is NON-RENEWABLE (no refresh token is handed over)
 *     and the container is ephemeral.
 *
 * Sandbox: `--dangerously-bypass-approvals-and-sandbox` — Codex's own
 * landlock/seccomp sandbox is redundant (and often unavailable) inside the
 * already-isolated, credential-free, egress-locked agent container, which IS
 * the boundary. This is the documented "externally sandboxed" use of that flag
 * and mirrors the Pi/Claude runners enabling native tools freely in the sandbox.
 *
 * Terminal status is runner-authoritative: Codex `exec` ends a turn with
 * `turn.completed` (carrying usage) and ends the process by closing stdout —
 * there is no explicit success message, so the status is decided here from the
 * process exit code + any `turn.failed` recorded by the mapper.
 */

import { rm } from "node:fs/promises";
import type { RunEvent, ExecutionContext } from "@appstrate/afps-runtime/types";
import { reduceEvents, type RunError, type RunResult } from "@appstrate/afps-runtime/runner";
import type { Runner, RunOptions } from "@appstrate/afps-runtime/runner";
import {
  buildCodexConfigToml,
  buildCodexEnv,
  readNdjsonLines,
  redactSecrets,
  safeParseJson,
  writeCodexAuthHome,
  writeCodexConfig,
  type CodexEvent,
  type CodexHttpMcpServer,
  type VendedCodexCredential,
} from "@appstrate/core/codex-binary";
import {
  buildRuntimeToolDefs,
  reEmitRuntimeToolEvents,
  type RuntimeToolDef,
} from "@appstrate/core/runtime-tool-defs";
import { getErrorMessage } from "@appstrate/core/errors";
import { CodexRunEventMapper, computeCodexCost, type CodexModelCost } from "./run-event-mapper.ts";

/** Subprocess handle shape (Bun.spawn) — the minimum the runner drives. */
export interface CodexChild {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
}

/** Injectable spawner — defaults to {@link Bun.spawn} (narrowed). */
export type CodexSpawnFn = (
  cmd: string[],
  opts: { cwd: string; env: Record<string, string> },
) => CodexChild;

export interface CodexAgentRunnerOptions {
  /** Absolute path to the prebuilt `codex` binary (`@appstrate/core/codex-binary`). */
  binaryPath: string;
  /** Real upstream model id (e.g. `gpt-5.5`) — NOT the platform model label. */
  modelId: string;
  /** Enriched platform system prompt (the agent persona + host context). */
  systemPrompt: string;
  /**
   * Sidecar credential-vend endpoint (`…/credential-vend`). GET-ed once at run
   * start to obtain the real subscription token. Internal-network-gated; no
   * bearer (the agent container holds no run token — zero-knowledge boundary).
   */
  credentialUrl: string;
  /** Working directory for the binary's native file/exec tools (the run workspace). */
  cwd: string;
  /**
   * Platform tool surface — the sidecar's stateless Streamable-HTTP `/mcp`
   * (integrations + `api_call` + `run_history` + `recall_memory` + the
   * agent-selected runtime tools). Written into codex's `config.toml` as a
   * `[mcp_servers.platform]` entry so the CLI's MCP client reaches the same
   * tools the Claude runner gets through the Agent SDK's `mcpServers`. Omit to
   * run codex with no platform tools (native sandbox tools only).
   */
  sidecarMcp?: CodexHttpMcpServer;
  /**
   * Agent-selected runtime tools (`manifest.runtime_tools`) — the SAME set the
   * sidecar serves over `/mcp`. The runner re-derives each runtime tool's
   * canonical RunEvent locally from the observed `mcp_tool_call` args (codex's
   * `exec --json` stream drops the MCP result `_meta` the events ride in, so —
   * unlike Pi/Claude — the runner cannot re-emit from the result; it replays the
   * shared pure handler instead). Empty/absent → no runtime tools.
   */
  runtimeTools?: readonly string[];
  /** Output JSON Schema (when the agent declares `output.schema`) — drives the `output` runtime tool. */
  outputSchema?: Record<string, unknown> | null;
  /** Per-million-token cost rates for equivalent-cost reporting; cost is 0 when absent. */
  modelCost?: CodexModelCost | null;
  /** Extra curated env merged into the spawned binary's environment. */
  env?: Record<string, string>;
  /** Injectable spawner. Defaults to the real `Bun.spawn`. */
  spawn?: CodexSpawnFn;
  /** Injectable fetch (vend). Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
}

/** Normalise the run input (`z.unknown()`) into prompt text. */
function inputToText(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (input == null) return "";
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

/** Fold the system persona + run input into a single `codex exec` prompt. */
export function buildCodexRunPrompt(systemPrompt: string, input: unknown): string {
  const task = inputToText(input) || "Begin the task described in your instructions.";
  return systemPrompt ? `${systemPrompt}\n\n---\n\n${task}` : task;
}

const defaultSpawn: CodexSpawnFn = (cmd, opts) =>
  Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  }) as unknown as CodexChild;

export class CodexAgentRunner implements Runner {
  readonly name = "codex-agent-runner";

  constructor(private readonly opts: CodexAgentRunnerOptions) {}

  async run(options: RunOptions): Promise<void> {
    const { context, eventSink, signal } = options;
    signal?.throwIfAborted();

    const runId = context.runId;
    const now = this.opts.now ?? Date.now;
    const fetchFn = this.opts.fetchFn ?? fetch;
    const spawn = this.opts.spawn ?? defaultSpawn;
    const startTime = now();

    const events: RunEvent[] = [];
    const emit = async (event: RunEvent): Promise<void> => {
      events.push(event);
      await eventSink.handle(event);
    };

    const mapper = new CodexRunEventMapper(runId, now);

    // Runtime tools (log/note/pin/report/output) the sidecar also serves over
    // `/mcp`: the runner replays each one's shared PURE handler on the observed
    // call args to reconstruct the canonical RunEvent codex drops, then emits it
    // on the run's single sink (see `reemitRuntimeTool`). Built once per run.
    const runtimeDefs = new Map<string, RuntimeToolDef>();
    if (this.opts.runtimeTools?.length || this.opts.outputSchema) {
      for (const def of buildRuntimeToolDefs({
        ...(this.opts.runtimeTools ? { runtimeTools: this.opts.runtimeTools } : {}),
        outputSchema: this.opts.outputSchema ?? null,
      })) {
        runtimeDefs.set(def.descriptor.name, def);
      }
    }
    const pendingRuntimeArgs = new Map<string, unknown>();

    let home: string | undefined;
    let child: CodexChild | undefined;
    const onAbort = () => {
      try {
        child?.kill();
      } catch {
        // already exited
      }
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    try {
      // 1. Vend the real subscription token (internal-network-gated, no bearer).
      const vend = await fetchFn(this.opts.credentialUrl);
      if (!vend.ok) {
        throw new Error(
          vend.status === 410
            ? "The ChatGPT subscription credential needs reconnection (revoked or expired)."
            : `Credential vend failed (${vend.status}).`,
        );
      }
      const cred = (await vend.json()) as VendedCodexCredential;

      // 2. Write the ephemeral CODEX_HOME/auth.json (real token, 0600).
      home = await writeCodexAuthHome({ credential: cred, nowMs: now(), prefix: "codex-run-" });

      // 2b. Write config.toml pointing codex's MCP client at the sidecar `/mcp`
      //     (integrations + api_call + run_history + recall_memory + runtime
      //     tools). The CLI auto-detects streamable HTTP from the url; auth +
      //     host scoping ride as literal http_headers. Same 0600 home as
      //     auth.json — no new at-rest credential surface. No-op when no
      //     sidecar MCP is configured.
      await writeCodexConfig({
        home,
        toml: buildCodexConfigToml({
          ...(this.opts.sidecarMcp ? { platform: this.opts.sidecarMcp } : {}),
        }),
      });

      // 3. Spawn the official binary. No `chatgpt_base_url` (it talks to the
      //    upstream directly; egress is locked by the sidecar allowlist). The
      //    container is the sandbox, so Codex's own sandbox is bypassed.
      child = spawn(
        [
          this.opts.binaryPath,
          "exec",
          "--json",
          "--skip-git-repo-check",
          "--dangerously-bypass-approvals-and-sandbox",
          "-m",
          this.opts.modelId,
          buildCodexRunPrompt(this.opts.systemPrompt, context.input),
        ],
        {
          cwd: this.opts.cwd,
          env: buildCodexEnv({
            codexHome: home,
            ...(this.opts.env ? { extra: this.opts.env } : {}),
          }),
        },
      );

      if (signal?.aborted) onAbort();

      // 4. Map the NDJSON event stream → RunEvents.
      for await (const line of readNdjsonLines(child.stdout)) {
        const ev = safeParseJson<CodexEvent>(line);
        if (!ev) continue;
        await this.reemitRuntimeTool(ev, runtimeDefs, pendingRuntimeArgs, runId, now, emit);
        for (const event of mapper.map(ev)) await emit(event);
      }

      const exitCode = await child.exited;

      // 5. Terminal verdict (runner-authoritative): a recorded turn.failed/error
      //    wins; otherwise the process exit code decides.
      const failure = mapper.failure();
      let status: NonNullable<RunResult["status"]>;
      let error: RunError | undefined;
      if (failure) {
        status = "failed";
        error = failure;
      } else if (exitCode === 0) {
        status = "success";
      } else {
        status = "failed";
        const stderr = await new Response(child.stderr as unknown as ReadableStream<Uint8Array>)
          .text()
          .catch(() => "");
        error = {
          code: "adapter_error",
          message: `The Codex CLI exited with code ${exitCode}${stderr ? `: ${redactSecrets(stderr, [cred.access_token]).slice(0, 500)}` : ""}`,
        };
        await emit({ type: "appstrate.error", timestamp: now(), runId, message: error.message });
      }

      const usage = mapper.usage();
      const cost = computeCodexCost(usage, this.opts.modelCost);
      const result = reduceEvents(events, error ? { error } : {});
      result.status = status;
      result.usage = usage;
      result.cost = cost;
      result.durationMs = now() - startTime;

      await eventSink.finalize(result);
    } catch (err) {
      if (signal?.aborted) {
        // Cancellation: propagate without finalizing — the caller's finally
        // block decides (mirrors the Claude/Pi runners).
        throw err;
      }
      const message = getErrorMessage(err);
      await emit({ type: "appstrate.error", timestamp: now(), runId, message });
      // reduceEvents (not emptyRunResult) so any partial canonical output the
      // agent emitted before the throw — memory.added / output.emitted /
      // log.written — survives into the failed result, matching the Pi + Claude
      // runners and the in-try non-zero-exit branch above.
      const result = reduceEvents(events, { error: { code: "adapter_error", message } });
      result.status = "failed";
      result.usage = mapper.usage();
      result.cost = computeCodexCost(mapper.usage(), this.opts.modelCost);
      result.durationMs = now() - startTime;
      await eventSink.finalize(result);
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (home) await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Reconstruct a runtime tool's canonical RunEvent(s) from an observed
   * `mcp_tool_call` and emit them on the run's sink.
   *
   * Codex's `exec --json` stream exposes a tool result's `content` /
   * `structured_content` but DROPS the MCP `_meta` field the canonical events
   * ride in (unlike the Pi MCP transport / the Claude in-process host, which
   * preserve `_meta` and re-emit it). The sidecar still EXECUTES the tool (the
   * model saw its text result), but the runner never sees the events. So the
   * runner replays the SAME shared, PURE handler (`@appstrate/core/runtime-tool-defs`)
   * on the observed call args to reconstruct them — no side effect is duplicated
   * (the handler only packages args into events; the reducer applies the effect
   * once at finalize), and they land on the run's single, correctly-sequenced
   * sink. Args are captured at `item.started` and replayed at a successful
   * `item.completed`; a failed call (or a replay error) emits nothing.
   */
  private async reemitRuntimeTool(
    ev: CodexEvent,
    defs: Map<string, RuntimeToolDef>,
    pending: Map<string, unknown>,
    runId: string,
    now: () => number,
    emit: (event: RunEvent) => Promise<void>,
  ): Promise<void> {
    if (defs.size === 0) return;
    const item = ev.item;
    if (!item || item.type !== "mcp_tool_call" || typeof item.tool !== "string") return;
    const def = defs.get(item.tool);
    if (!def) return;

    if (ev.type === "item.started") {
      if (typeof item.id === "string" && item.arguments !== undefined) {
        pending.set(item.id, item.arguments);
      }
      return;
    }
    if (ev.type !== "item.completed") return;

    const id = typeof item.id === "string" ? item.id : undefined;
    const args = item.arguments ?? (id ? pending.get(id) : undefined);
    if (id) pending.delete(id);
    // A failed tool call produced no canonical effect — nothing to reconstruct.
    if (item.status === "failed") return;

    try {
      const result = await def.handler(args);
      // Collect through the trust-boundary allowlist, then await-emit each so
      // re-emitted events keep the run's sink ordering (the allowlist drops any
      // non-canonical type a handler might return).
      const collected: RunEvent[] = [];
      reEmitRuntimeToolEvents(result._meta, (e) => {
        // Stamp runId (handlers are run-agnostic; the sink routes by runId) and
        // default the timestamp, mirroring the mapper's own events.
        collected.push({ timestamp: now(), ...(e as Record<string, unknown>), runId } as RunEvent);
      });
      for (const e of collected) await emit(e);
    } catch {
      // A replay failure must never fail the run — the tool's text result
      // already reached the model; only the reconstructed event is lost.
    }
  }
}

export type { ExecutionContext };
