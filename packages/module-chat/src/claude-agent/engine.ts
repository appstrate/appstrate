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
 *     never get host execution. Only the platform HTTP MCP (meta-tools) is
 *     exposed; `bypassPermissions` auto-approves just those.
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
import { SdkUiStreamMapper, type ClaudeSdkMessage } from "./ui-stream-mapper.ts";
import { acquireClaudeSlot } from "./concurrency.ts";
import { chatCapacityResponse } from "../concurrency-gate.ts";
import { buildTranscriptPrompt } from "../transcript.ts";
import { logger } from "../logger.ts";

/** Upper bound on agent turns per chat message (mirrors the ai-sdk path's MAX_STEPS). */
const MAX_TURNS = 16;

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

/**
 * Build the `mcpServers` config: the platform HTTP MCP when available, else
 * none. (Typed loosely — the SDK's McpServerConfig union is broad and not
 * re-exported conveniently.)
 */
function buildMcpServers(input: ClaudeAgentChatInput): Record<string, unknown> | undefined {
  if (!input.platformMcp) return undefined;
  return {
    platform: {
      type: "http",
      url: input.platformMcp.url,
      headers: input.platformMcp.headers,
    },
  };
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
  if (!slot) return chatCapacityResponse("Claude");

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
          prompt: buildTranscriptPrompt(input.messages),
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
