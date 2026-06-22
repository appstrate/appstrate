// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * CodexAgentRunner — AFPS {@link Runner} backed by the official OpenAI Codex
 * CLI (`codex exec --json`).
 *
 * The official-binary (no-forging) counterpart of the Pi runner for `codex`
 * (ChatGPT Plus/Pro/Business subscription) runs. Codex is agent-only — it has
 * no chat surface (its token can't be safely held host-side). It drives the
 * official `codex` binary as a subprocess — the binary signs its OWN client
 * fingerprint (`originator: codex_exec`) and sends its own `chatgpt-account-id`,
 * so NOTHING is forged. Subscription use is an operator opt-in grey-zone (see
 * docs/architecture/SUBSCRIPTION_COMPLIANCE.md).
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
} from "./codex-binary.ts";
import { drainAndEmitInto, type RuntimeEventDrainer } from "@appstrate/core/runtime-event-drain";
import { getErrorMessage } from "@appstrate/core/errors";
import { CodexRunEventMapper, computeCodexCost, type CodexModelCost } from "./run-event-mapper.ts";

/** Subprocess handle shape (Bun.spawn) — the minimum the runner drives. */
export interface CodexChild {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  /** SIGTERM by default; pass `9` (SIGKILL) to force-kill after the grace window. */
  kill(signal?: number): void;
}

/** Grace period between SIGTERM and the SIGKILL escalation on abort. */
const ABORT_KILL_GRACE_MS = 5_000;

/** Injectable spawner — defaults to {@link Bun.spawn} (narrowed). */
export type CodexSpawnFn = (
  cmd: string[],
  opts: { cwd: string; env: Record<string, string> },
) => CodexChild;

export interface CodexAgentRunnerOptions {
  /** Absolute path to the prebuilt `codex` binary (`./codex-binary.ts`). */
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
   * Runtime-event drainer (`@appstrate/core/runtime-event-drain`). The sidecar
   * executes each runtime tool (log/note/pin/report/output) ONCE and journals
   * its canonical events; this runner drains them at each NDJSON step boundary
   * (codex's `exec --json` stream never surfaces the MCP result `_meta` the
   * events would otherwise ride in) and re-emits on the run's single sink.
   * Omit when the run has no runtime tools (nothing to drain).
   */
  drainer?: RuntimeEventDrainer;
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

/** Max bytes of stderr tail retained for a non-zero-exit diagnostic. */
const MAX_STDERR_TAIL_BYTES = 128 * 1024;

interface StreamTail {
  /** Resolves once the stream is fully drained (or errored). */
  readonly done: Promise<void>;
  /** The captured tail (last {@link MAX_STDERR_TAIL_BYTES}); await-safe after `done`. */
  text(): Promise<string>;
}

/**
 * Drain a byte stream CONCURRENTLY into a bounded tail buffer, starting
 * immediately. The codex CLI can emit verbose stderr while we consume stdout;
 * if stderr is left unread its OS pipe buffer (~64 KB) fills and the child
 * BLOCKS on write — a deadlock, since it then never closes stdout/exits. Draining
 * it in parallel keeps the pipe clear; we keep only the tail for diagnostics.
 */
function drainStreamTail(stream: ReadableStream<Uint8Array>, maxBytes: number): StreamTail {
  let buf = "";
  const decoder = new TextDecoder();
  const clamp = () => {
    if (buf.length > maxBytes) buf = buf.slice(buf.length - maxBytes);
  };
  const done = (async () => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        if (value) {
          buf += decoder.decode(value, { stream: true });
          clamp();
        }
      }
      buf += decoder.decode();
      clamp();
    } finally {
      reader.releaseLock();
    }
  })();
  return { done, text: async () => (await done.catch(() => undefined), buf) };
}

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

    // Runtime tools (log/note/pin/report/output) are executed ONCE by the
    // sidecar, which journals their canonical events. Drain the journal at each
    // NDJSON step boundary and re-emit on the run's single sink — codex never
    // surfaces the MCP result `_meta`, so the events come exclusively from the
    // journal. A drain is cheap on localhost and a no-op when the journal is
    // empty; over-draining never misses a boundary. No-op when no drainer wired.
    const drainer = this.opts.drainer;
    // Shared drain+stamp+emit (see `@appstrate/core/runtime-event-drain`): one
    // cadence + best-effort-at-finalize contract for all three runners, so it
    // cannot drift between them.
    const drainAndEmit = (final = false): Promise<void> =>
      drainAndEmitInto({ drainer, emit: (e) => emit(e as RunEvent), now, runId, final });

    let home: string | undefined;
    let child: CodexChild | undefined;
    let stderrTail: StreamTail | undefined;
    const onAbort = () => {
      try {
        child?.kill(); // SIGTERM — let codex flush + exit cleanly first.
      } catch {
        // already exited
      }
      // Escalate to SIGKILL if it ignores SIGTERM past the grace window (a
      // wedged codex must not outlive an abort). Unref'd so this timer never
      // keeps the process alive; a no-op throw if the child already exited.
      const killTimer = setTimeout(() => {
        try {
          child?.kill(9);
        } catch {
          // already exited
        }
      }, ABORT_KILL_GRACE_MS);
      (killTimer as unknown as { unref?: () => void }).unref?.();
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

      // Drain stderr CONCURRENTLY with stdout from the moment of spawn — leaving
      // it unread risks a pipe-buffer deadlock (see drainStreamTail). We keep
      // only the tail, read on a non-zero exit for the failure diagnostic.
      stderrTail = drainStreamTail(
        child.stderr as unknown as ReadableStream<Uint8Array>,
        MAX_STDERR_TAIL_BYTES,
      );

      // 4. Map the NDJSON event stream → RunEvents, draining journaled runtime
      //    events at item-completion boundaries (a runtime tool only journals
      //    once its handler has run, i.e. at `item.completed`). Draining on
      //    every NDJSON line would fire hundreds of empty round-trips on a
      //    chatty stream; the final drain below backstops any straggler.
      for await (const line of readNdjsonLines(child.stdout)) {
        const ev = safeParseJson<CodexEvent>(line);
        if (!ev) continue;
        for (const event of mapper.map(ev)) await emit(event);
        if (ev.type === "item.completed") await drainAndEmit();
      }

      const exitCode = await child.exited;

      // Final drain (drain-until-empty + bounded retry): the sidecar is torn
      // down right after finalize, so the last tool's events must be pulled now.
      await drainAndEmit(true);

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
        // Read the concurrently-drained tail (NOT child.stderr directly — it was
        // already consumed by the drain, and reading it post-exit risked the
        // deadlock the drain exists to prevent).
        const stderr = stderrTail ? await stderrTail.text() : "";
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
      // Best-effort final drain: a mid-run throw may leave journaled events the
      // agent produced before failing (memory.added / log.written / output).
      await drainAndEmit(true);
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
      // Let the stderr drain settle so its reader unwinds (no dangling lock /
      // unhandled rejection) regardless of how we exited the try.
      if (stderrTail) await stderrTail.done.catch(() => undefined);
      if (home) await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export type { ExecutionContext };
