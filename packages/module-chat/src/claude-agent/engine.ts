// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Agent SDK chat engine — the `claude-code` (Claude subscription) path
 * of the chat, the clean/sanctioned counterpart to the `ai-sdk` engine.
 *
 * It drives the official `@anthropic-ai/claude-agent-sdk` `query()` IN-PROCESS
 * under Bun (via the prebuilt native binary — see binary.ts), pointed at the
 * non-forging credential-injection gateway (ANTHROPIC_BASE_URL), and maps the
 * SDK's message stream onto the same AI SDK UI message stream the `ai-sdk`
 * engine emits (see ui-stream-mapper.ts) so the chat client is engine-agnostic.
 *
 * Security posture:
 *   - `tools: []` disables ALL built-in tools (Bash/Edit/Write/…) — a chat must
 *     never get host execution. Only our MCP servers (platform meta-tools +
 *     render_html/wait_for_run) are exposed; `bypassPermissions` auto-approves
 *     just those.
 *   - The spawned binary gets a CURATED env (no platform secrets), with only a
 *     placeholder bearer; the real subscription token is injected by the
 *     gateway, server-side.
 *   - `settingSources: []` + `persistSession: false`: no filesystem config /
 *     transcript bleed.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildClaudeSdkEnv } from "@appstrate/core/claude-binary";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import { resolveClaudeCodeBinary } from "./binary.ts";
import { createLocalToolsServer, type LocalToolsContext } from "./local-tools.ts";
import { SdkUiStreamMapper, type ClaudeSdkMessage } from "./ui-stream-mapper.ts";
import { acquireClaudeSlot } from "./concurrency.ts";
import { logger } from "../logger.ts";

/** Upper bound on agent turns per chat message (mirrors the ai-sdk path's MAX_STEPS). */
const MAX_TURNS = 16;

/**
 * Returned (instead of a stream) when the engine is at its subprocess cap, so
 * the client backs off rather than the instance forking unbounded binaries.
 * A 429 problem+json — `useChat` surfaces it as a turn error.
 */
function capacityResponse(): Response {
  const retryAfterSeconds = 5;
  return new Response(
    JSON.stringify({
      type: "https://docs.appstrate.dev/errors/chat-capacity",
      title: "Too Many Requests",
      status: 429,
      detail:
        "Le service de chat Claude est temporairement saturé. Réessayez dans quelques instants.",
      code: "chat_capacity",
      retryAfter: retryAfterSeconds,
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

export interface ClaudeAgentChatInput {
  /** Full thread from the client (assistant-ui sends every turn). */
  messages: UIMessage[];
  /** System persona (+ MCP instructions + host context), already assembled. */
  system: string;
  /** Real upstream model id (e.g. `claude-haiku-4-5`) — NOT the preset id. */
  modelId: string;
  /** ANTHROPIC_BASE_URL: the non-forging gateway, `…/claude-code-sdk/:presetId`. */
  gatewayBaseUrl: string;
  /** Placeholder bearer the SDK sends; the gateway swaps it for the real token. */
  placeholderToken: string;
  /** Platform HTTP MCP server (meta-tools), omitted when the mcp module is off. */
  platformMcp?: { url: string; headers: Record<string, string> };
  /** Context for the in-process tools (origin + forwarded RBAC headers). */
  localTools: LocalToolsContext;
  /** Aborts the SDK query when the client disconnects. */
  abortSignal: AbortSignal;
  /** Maps a thrown error to a client-safe message (AI SDK masks errors by default). */
  onError: (error: unknown) => string;
}

/**
 * Curated environment for the spawned `claude` binary. Thin wrapper over the
 * shared `@appstrate/core/claude-binary` builder (single source for the
 * credential-isolation posture shared with the agent runner); keeps the chat's
 * positional signature for its existing call site + tests.
 */
export function buildSdkEnv(
  gatewayBaseUrl: string,
  placeholderToken: string,
): Record<string, string> {
  return buildClaudeSdkEnv({ baseUrl: gatewayBaseUrl, placeholderToken });
}

/** Flatten the UI thread into a transcript prompt (the SDK takes a prompt, not a UIMessage[]). */
export function buildPromptFromMessages(messages: UIMessage[]): string {
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

  if (turns.length === 0) return "";
  // Single user turn → send it directly. Otherwise a labelled transcript gives
  // the (stateless, persistSession:false) SDK the full conversational context.
  if (turns.length === 1) return turns[0]!.text;
  return turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n\n");
}

/**
 * Build the `mcpServers` config: always the in-process local tools, plus the
 * platform HTTP MCP when available. (Typed loosely — the SDK's McpServerConfig
 * union is broad and not re-exported conveniently.)
 */
function buildMcpServers(input: ClaudeAgentChatInput): Record<string, unknown> {
  const servers: Record<string, unknown> = {
    appstrate_local: createLocalToolsServer(input.localTools),
  };
  if (input.platformMcp) {
    servers.platform = {
      type: "http",
      url: input.platformMcp.url,
      headers: input.platformMcp.headers,
    };
  }
  return servers;
}

/**
 * Run one chat turn through the Claude Agent SDK and return a UI-message-stream
 * Response (identical wire contract to the ai-sdk path's
 * `toUIMessageStreamResponse`).
 */
export function runClaudeAgentChat(input: ClaudeAgentChatInput): Response {
  // Resolve the binary BEFORE reserving a slot so a resolution failure can't
  // leak a slot (it throws straight out, no acquire held).
  const binary = resolveClaudeCodeBinary();

  // Bound the number of concurrent `claude` subprocesses per instance.
  const slot = acquireClaudeSlot();
  if (!slot) return capacityResponse();

  const controller = new AbortController();
  if (input.abortSignal.aborted) controller.abort();
  else input.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });

  const mapper = new SdkUiStreamMapper();

  const stream = createUIMessageStream({
    onError: input.onError,
    execute: async ({ writer }) => {
      // The finally guarantees the slot is freed on success, SDK error, AND
      // client abort (the for-await unwinds when the controller aborts).
      try {
        writer.write(mapper.startChunk(crypto.randomUUID()));

        const response = query({
          prompt: buildPromptFromMessages(input.messages),
          options: {
            pathToClaudeCodeExecutable: binary,
            env: buildSdkEnv(input.gatewayBaseUrl, input.placeholderToken),
            model: input.modelId,
            systemPrompt: input.system,
            tools: [], // disable ALL built-ins — chat must not get host execution
            mcpServers: buildMcpServers(input) as never,
            includePartialMessages: true,
            permissionMode: "bypassPermissions",
            settingSources: [],
            persistSession: false,
            maxTurns: MAX_TURNS,
            abortController: controller,
          },
        });

        for await (const message of response) {
          for (const chunk of mapper.map(message as ClaudeSdkMessage)) writer.write(chunk);
        }

        const meta = mapper.resultMeta();
        if (meta?.isError) {
          logger.warn("claude-agent chat turn ended in error", { finishReason: meta.finishReason });
          writer.write({ type: "error", errorText: meta.errorText ?? input.onError(undefined) });
        }
        writer.write(mapper.finishChunk());
      } finally {
        slot.release();
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
