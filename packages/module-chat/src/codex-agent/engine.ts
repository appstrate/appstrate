// SPDX-License-Identifier: Apache-2.0

/**
 * Codex CLI chat engine — the `codex` (ChatGPT subscription) path of the chat,
 * the ToS-clean counterpart of the `claude-agent` engine.
 *
 * It drives the official `codex` binary as a subprocess
 * (`codex exec --json …`), pointed at the non-forging credential-injection
 * gateway via `-c chatgpt_base_url=…`, and maps the CLI's `--json` event stream
 * onto the same AI SDK UI message stream the other engines emit
 * (see ui-stream-mapper.ts) so the chat client is engine-agnostic.
 *
 * Security posture (mirrors claude-agent):
 *   - `-s read-only`: the codex sandbox may read but never write/execute against
 *     the host — a chat must not get host mutation. It runs in a throwaway empty
 *     working directory.
 *   - The spawned binary's `CODEX_HOME/auth.json` holds only a PLACEHOLDER
 *     bearer (the turn-scoped chat-loopback token, sent verbatim by the CLI);
 *     the gateway swaps it for the real subscription token + stamps the real
 *     `chatgpt-account-id` server-side, so neither ever enters the subprocess.
 *   - The curated env (`@appstrate/core/codex-binary`) carries no platform
 *     secrets and routes outbound traffic through the forward proxy when set.
 *
 * Token usage is driver-authoritative: read from the CLI's `turn.completed`
 * event and surfaced in the finish chunk's metadata.
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import {
  buildCodexAuthJson,
  buildCodexEnv,
  makeCodexScopeResolver,
  resolveCodexBinary,
} from "@appstrate/core/codex-binary";
import { CodexUiStreamMapper, type CodexEvent } from "./ui-stream-mapper.ts";
import { acquireCodexSlot } from "./concurrency.ts";
import { logger } from "../logger.ts";

/**
 * Resolve the `codex` binary. Order: explicit `CODEX_BINARY_PATH` override →
 * the bundled per-arch package in this module's install scope → bare `codex` on
 * `PATH` (dev with a global install; images that put it on PATH). The override
 * is how the production image points at its bundled binary.
 */
function resolveBinary(): string {
  const override = process.env.CODEX_BINARY_PATH;
  if (override) return override;
  try {
    return resolveCodexBinary({ resolve: makeCodexScopeResolver(import.meta.url) });
  } catch {
    return "codex";
  }
}

export interface CodexAgentChatInput {
  /** Full thread from the client (assistant-ui sends every turn). */
  messages: UIMessage[];
  /** System persona (+ host context), already assembled. */
  system: string;
  /** Real upstream model id (e.g. `gpt-5.4-mini`) — NOT the preset id. */
  modelId: string;
  /** `chatgpt_base_url`: the non-forging gateway, `…/codex-sdk/:presetId`. */
  gatewayBaseUrl: string;
  /** Placeholder bearer written to auth.json; the gateway swaps it server-side. */
  accessToken: string;
  /** Aborts the codex subprocess when the client disconnects. */
  abortSignal: AbortSignal;
  /** Maps a thrown error to a client-safe message. */
  onError: (error: unknown) => string;
}

/**
 * Returned (instead of a stream) when the engine is at its subprocess cap, so
 * the client backs off rather than the instance forking unbounded binaries.
 */
function capacityResponse(): Response {
  const retryAfterSeconds = 5;
  return new Response(
    JSON.stringify({
      type: "https://docs.appstrate.dev/errors/chat-capacity",
      title: "Too Many Requests",
      status: 429,
      detail:
        "Le service de chat Codex est temporairement saturé. Réessayez dans quelques instants.",
      code: "chat_capacity",
      retry_after: retryAfterSeconds,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/problem+json",
        "retry-after": String(retryAfterSeconds),
      },
    },
  );
}

/** Flatten the UI thread + system persona into a single prompt for `codex exec`. */
export function buildCodexPrompt(messages: UIMessage[], system: string): string {
  const textOf = (m: UIMessage): string =>
    (m.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("")
      .trim();

  const turns = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, text: textOf(m) }))
    .filter((t) => t.text.length > 0);

  const transcript =
    turns.length === 1
      ? turns[0]!.text
      : turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n\n");

  return system ? `${system}\n\n---\n\n${transcript}` : transcript;
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

/**
 * Run one chat turn through the Codex CLI and return a UI-message-stream
 * Response (identical wire contract to the other engines).
 */
export function runCodexAgentChat(input: CodexAgentChatInput): Response {
  // Resolve the binary BEFORE reserving a slot so a resolution failure can't
  // leak a slot (it throws straight out, no acquire held).
  const binary = resolveBinary();

  const slot = acquireCodexSlot();
  if (!slot) return capacityResponse();

  const mapper = new CodexUiStreamMapper();

  const stream = createUIMessageStream({
    onError: input.onError,
    execute: async ({ writer }) => {
      let home: string | undefined;
      let child: ReturnType<typeof Bun.spawn> | undefined;
      const onAbort = () => {
        try {
          child?.kill();
        } catch {
          // already exited
        }
      };
      try {
        writer.write(mapper.startChunk(crypto.randomUUID()));

        home = await mkdtemp(join(tmpdir(), "codex-chat-"));
        await writeFile(
          join(home, "auth.json"),
          JSON.stringify(buildCodexAuthJson({ accessToken: input.accessToken, nowMs: Date.now() })),
          { mode: 0o600 },
        );

        child = Bun.spawn(
          [
            binary,
            "exec",
            "--json",
            "--skip-git-repo-check",
            "-s",
            "read-only",
            "-c",
            `chatgpt_base_url=${input.gatewayBaseUrl}`,
            "-m",
            input.modelId,
            buildCodexPrompt(input.messages, input.system),
          ],
          {
            cwd: home,
            env: buildCodexEnv({ codexHome: home }),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          },
        );

        if (input.abortSignal.aborted) onAbort();
        else input.abortSignal.addEventListener("abort", onAbort, { once: true });

        for await (const line of readLines(child.stdout as ReadableStream<Uint8Array>)) {
          const ev = safeParse(line);
          if (!ev) continue;
          for (const chunk of mapper.map(ev)) writer.write(chunk);
        }

        const exitCode = await child.exited;
        const meta = mapper.resultMeta();
        if (meta?.isError) {
          writer.write({ type: "error", errorText: meta.errorText ?? input.onError(undefined) });
        } else if (exitCode !== 0 && !meta) {
          // Non-zero exit with no in-band error event — surface a generic error.
          const stderr = await new Response(child.stderr as ReadableStream<Uint8Array>)
            .text()
            .catch(() => "");
          logger.warn("codex chat exited non-zero", { exitCode, stderr: stderr.slice(0, 500) });
          writer.write({ type: "error", errorText: input.onError(undefined) });
        }
        writer.write(mapper.finishChunk());
      } finally {
        input.abortSignal.removeEventListener("abort", onAbort);
        slot.release();
        if (home) await rm(home, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
