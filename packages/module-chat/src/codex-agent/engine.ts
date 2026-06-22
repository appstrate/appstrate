// SPDX-License-Identifier: Apache-2.0

/**
 * Codex CLI chat engine — the `codex` (ChatGPT subscription) path of the chat,
 * the ToS-clean counterpart of the `claude-agent` engine.
 *
 * It drives the official `codex` binary as a subprocess
 * (`codex exec --json …`) and maps the CLI's `--json` event stream onto the same
 * AI SDK UI message stream the other engines emit (see ui-stream-mapper.ts) so
 * the chat client is engine-agnostic. The CLI calls `chatgpt.com` directly and
 * ignores any `chatgpt_base_url` override, so there is no reverse-proxy gateway:
 * the real subscription token is vended first-party at turn start and written
 * into the binary's `auth.json`.
 *
 * Security posture (mirrors claude-agent):
 *   - `-s read-only`: the codex sandbox may read but never write/execute against
 *     the host — a chat must not get host mutation. It runs in a throwaway empty
 *     working directory.
 *   - The spawned binary's `CODEX_HOME/auth.json` holds the REAL subscription
 *     token (vended first-party at turn start) — the CLI sends it verbatim to
 *     `chatgpt.com`. Chat runs on the platform host itself (not a sandboxed
 *     container), so the token stays inside the trust boundary that already holds
 *     every credential; the temp `CODEX_HOME` is written 0600 and removed in
 *     `finally`.
 *   - The curated env (`@appstrate/core/codex-binary`) carries no platform
 *     secrets and routes outbound traffic through the forward proxy when set.
 *
 * Token usage is driver-authoritative: read from the CLI's `turn.completed`
 * event and surfaced in the finish chunk's metadata.
 */

import { rm } from "node:fs/promises";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import {
  buildCodexEnv,
  makeCodexScopeResolver,
  readNdjsonLines,
  redactSecrets,
  resolveCodexBinary,
  safeParseJson,
  writeCodexAuthHome,
  type VendedCodexCredential,
} from "@appstrate/core/codex-binary";
import { CodexUiStreamMapper, type CodexEvent } from "./ui-stream-mapper.ts";
import { acquireCodexSlot } from "./concurrency.ts";
import { buildTranscriptPrompt } from "../transcript.ts";
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
  /** First-party credential-vend endpoint, `…/api/llm-proxy/codex-sdk/:presetId`. */
  credentialUrl: string;
  /** Loopback bearer authorizing the vend GET (resolved to the caller's identity). */
  loopbackToken: string;
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

        // Vend the real subscription credential server-side (first-party). The
        // CLI needs the genuine token in auth.json — it calls chatgpt.com
        // directly and ignores chatgpt_base_url for its models-manager.
        const vend = await fetch(input.credentialUrl, {
          headers: { authorization: `Bearer ${input.loopbackToken}` },
        });
        if (!vend.ok) {
          writer.write({
            type: "error",
            errorText:
              vend.status === 401
                ? "Reconnectez votre abonnement ChatGPT — la connexion a expiré ou été révoquée."
                : input.onError(undefined),
          });
          writer.write(mapper.finishChunk());
          return;
        }
        const cred = (await vend.json()) as VendedCodexCredential;

        home = await writeCodexAuthHome({
          credential: cred,
          nowMs: Date.now(),
          prefix: "codex-chat-",
        });

        child = Bun.spawn(
          [
            binary,
            "exec",
            "--json",
            "--skip-git-repo-check",
            "-s",
            "read-only",
            "-m",
            input.modelId,
            buildTranscriptPrompt(input.messages, { system: input.system }),
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

        for await (const line of readNdjsonLines(child.stdout as ReadableStream<Uint8Array>)) {
          const ev = safeParseJson<CodexEvent>(line);
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
          logger.warn("codex chat exited non-zero", {
            exitCode,
            stderr: redactSecrets(stderr).slice(0, 500),
          });
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
