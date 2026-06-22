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
 * Tools (parity with the claude-agent engine, which wires `mcpServers` on the
 * SDK): codex's MCP client is independent of its un-proxyable models-manager, so
 * a `config.toml` written into `CODEX_HOME` points it at two MCP servers —
 * `platform` (streamable HTTP → the meta-tools at `/api/mcp/o/:org`, with the
 * caller's forwarded headers, RBAC re-applied server-side) and `appstrate_local`
 * (stdio → render_html + wait_for_run, see local-tools-stdio.ts). Both
 * auto-approve their tools (`default_tools_approval_mode = "approve"`) so the
 * non-interactive `exec` never blocks; the `-s read-only` sandbox is independent
 * and still walls off codex's OWN file/exec tools.
 *
 * Token usage is driver-authoritative: read from the CLI's `turn.completed`
 * event and surfaced in the finish chunk's metadata.
 */

import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import {
  buildCodexConfigToml,
  buildCodexEnv,
  makeCodexScopeResolver,
  readNdjsonLines,
  redactSecrets,
  resolveCodexBinary,
  safeParseJson,
  writeCodexAuthHome,
  writeCodexConfig,
  type CodexEvent,
  type VendedCodexCredential,
} from "@appstrate/core/codex-binary";
import { CodexUiStreamMapper } from "./ui-stream-mapper.ts";
import { acquireCodexSlot } from "./concurrency.ts";
import { chatCapacityResponse } from "../concurrency-gate.ts";
import { buildTranscriptPrompt } from "../transcript.ts";
import { logger } from "../logger.ts";

/** mkdtemp prefix for the chat codex token home — also swept at boot. */
export const CODEX_CHAT_HOME_PREFIX = "codex-chat-";

/**
 * Base dir for the chat codex `auth.json` home. The chat engine runs on the
 * platform host (not a container), so prefer a RAM-backed dir (`/dev/shm`) when
 * present — the real token is then never written to a physical disk at rest.
 * Falls back to the OS temp dir (e.g. macOS dev, where `/dev/shm` is absent).
 */
export function codexChatHomeBase(): string | undefined {
  return existsSync("/dev/shm") ? "/dev/shm" : undefined;
}

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
  /**
   * Platform HTTP MCP server (meta-tools at `/api/mcp/o/:org`), omitted when the
   * `mcp` module is off. Wired into codex via `config.toml` as a streamable-HTTP
   * server with the caller's forwarded headers (RBAC fidelity).
   */
  platformMcp?: { url: string; headers: Record<string, string> };
  /**
   * Context for the local tools (`render_html` + `wait_for_run`), served to
   * codex by a spawned stdio MCP server (local-tools-stdio.ts) — the parity
   * counterpart of the Claude engine's in-process `appstrate_local` server.
   */
  localTools: { origin: string; headers: Record<string, string> };
  /** Aborts the codex subprocess when the client disconnects. */
  abortSignal: AbortSignal;
  /** Maps a thrown error to a client-safe message. */
  onError: (error: unknown) => string;
}

/** Absolute path to the stdio local-tools MCP server script (spawned by codex). */
const LOCAL_TOOLS_SCRIPT = fileURLToPath(new URL("./local-tools-stdio.ts", import.meta.url));

/**
 * Run one chat turn through the Codex CLI and return a UI-message-stream
 * Response (identical wire contract to the other engines).
 */
export function runCodexAgentChat(input: CodexAgentChatInput): Response {
  // Resolve the binary BEFORE reserving a slot so a resolution failure can't
  // leak a slot (it throws straight out, no acquire held).
  const binary = resolveBinary();

  const slot = acquireCodexSlot();
  if (!slot) return chatCapacityResponse("Codex");

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
        // directly and ignores chatgpt_base_url for its models-manager. The vend
        // honours the client's abort signal so a disconnect during the vend
        // window cancels it instead of vending + immediately killing a child.
        const vend = await fetch(input.credentialUrl, {
          headers: { authorization: `Bearer ${input.loopbackToken}` },
          signal: input.abortSignal,
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

        // Client gone between vend and spawn — don't write the token to disk or
        // fork the binary at all.
        if (input.abortSignal.aborted) {
          writer.write(mapper.finishChunk());
          return;
        }

        home = await writeCodexAuthHome({
          credential: cred,
          nowMs: Date.now(),
          prefix: CODEX_CHAT_HOME_PREFIX,
          baseDir: codexChatHomeBase(),
        });

        // Write the MCP config alongside auth.json (same 0600 ephemeral home):
        //   - `platform` (streamable HTTP) → the platform meta-tools, with the
        //     caller's forwarded headers as literal http_headers (RBAC fidelity).
        //   - `appstrate_local` (stdio) → render_html + wait_for_run, served by a
        //     bun subprocess codex spawns (this host's bun = process.execPath).
        // Both auto-approve their tools so the non-interactive `exec` never blocks
        // (the `-s read-only` sandbox still governs codex's OWN file/exec tools).
        await writeCodexConfig({
          home,
          toml: buildCodexConfigToml({
            platform: input.platformMcp,
            localTools: {
              command: process.execPath,
              args: [LOCAL_TOOLS_SCRIPT],
              env: {
                APPSTRATE_ORIGIN: input.localTools.origin,
                APPSTRATE_MCP_HEADERS: JSON.stringify(input.localTools.headers),
              },
            },
          }),
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
            stderr: redactSecrets(stderr, [cred.access_token]).slice(0, 500),
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
