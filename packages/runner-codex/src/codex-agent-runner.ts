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

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, ExecutionContext } from "@appstrate/afps-runtime/types";
import {
  reduceEvents,
  emptyRunResult,
  type RunError,
  type RunResult,
} from "@appstrate/afps-runtime/runner";
import type { Runner, RunOptions } from "@appstrate/afps-runtime/runner";
import { buildCodexAuthJson, buildCodexEnv } from "@appstrate/core/codex-binary";
import {
  CodexRunEventMapper,
  computeCodexCost,
  type CodexEvent,
  type CodexModelCost,
} from "./run-event-mapper.ts";

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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/** Split a byte stream into newline-delimited strings (UTF-8), flushing the tail. */
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
  const tail = (buf + decoder.decode()).trim();
  if (tail) yield tail;
}

function safeParse(line: string): CodexEvent | null {
  try {
    return JSON.parse(line) as CodexEvent;
  } catch {
    return null;
  }
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
      const cred = (await vend.json()) as { access_token: string; account_id?: string | null };

      // 2. Write the ephemeral CODEX_HOME/auth.json (real token, 0600).
      home = await mkdtemp(join(tmpdir(), "codex-run-"));
      await writeFile(
        join(home, "auth.json"),
        JSON.stringify(
          buildCodexAuthJson({
            accessToken: cred.access_token,
            accountId: cred.account_id,
            nowMs: now(),
          }),
        ),
        { mode: 0o600 },
      );

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
      for await (const line of readLines(child.stdout)) {
        const ev = safeParse(line);
        if (!ev) continue;
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
          message: `The Codex CLI exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
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
      const message = errorMessage(err);
      await emit({ type: "appstrate.error", timestamp: now(), runId, message });
      const result = emptyRunResult();
      result.status = "failed";
      result.error = { code: "adapter_error", message };
      result.usage = mapper.usage();
      result.cost = computeCodexCost(mapper.usage(), this.opts.modelCost);
      result.durationMs = now() - startTime;
      await eventSink.finalize(result);
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (home) await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export type { ExecutionContext };
