// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Agent SDK chat engine — the `claude-code` (Claude subscription) path
 * of the chat, the official-binary (no-forging) counterpart to the `ai-sdk`
 * engine. Subscription use is an operator opt-in grey-zone, not a ToS
 * certification (see docs/architecture/SUBSCRIPTION_COMPLIANCE.md).
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
import { buildClaudeSdkEnv } from "@appstrate/runner-claude/binary";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { createLogger } from "@appstrate/core/logger";
import type { ChatEngineInput } from "@appstrate/core/subscription-engines";
import { resolveClaudeCodeBinary } from "./binary.ts";
import { SdkUiStreamMapper, type ClaudeSdkMessage } from "./ui-stream-mapper.ts";
import { acquireClaudeSlot, chatCapacityResponse } from "./concurrency.ts";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

/** Upper bound on agent turns per chat message (mirrors the ai-sdk path's MAX_STEPS). */
const MAX_TURNS = 16;

/**
 * Wall-clock deadline for one chat turn. `maxTurns` bounds the agent loop, but a
 * single turn wedged on a stuck upstream or a hung MCP call would otherwise hold
 * the `claude` subprocess + a concurrency slot open indefinitely. On the deadline
 * we abort the controller (kills the subprocess, frees the slot via the finally).
 */
const TURN_DEADLINE_MS = 5 * 60_000;

/**
 * Build the `mcpServers` config: the platform HTTP MCP when available, else
 * none. (Typed loosely — the SDK's McpServerConfig union is broad and not
 * re-exported conveniently.)
 */
function buildMcpServers(input: ChatEngineInput): Record<string, unknown> | undefined {
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
export function runClaudeAgentChat(input: ChatEngineInput): Response {
  // Resolve the binary BEFORE reserving a slot so a resolution failure can't
  // leak a slot (it throws straight out, no acquire held).
  const binary = resolveClaudeCodeBinary();

  // Bound the number of concurrent `claude` subprocesses per instance.
  const slot = acquireClaudeSlot();
  if (!slot) return chatCapacityResponse("Claude");

  const controller = new AbortController();
  if (input.abortSignal.aborted) controller.abort();
  else input.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });

  // Wall-clock deadline: abort a turn wedged on a stuck upstream/MCP so it can't
  // pin the subprocess + slot open. Unref'd so it never keeps the process alive;
  // cleared in the execute finally on normal completion.
  const deadline = setTimeout(() => controller.abort(), TURN_DEADLINE_MS);
  (deadline as unknown as { unref?: () => void }).unref?.();

  const mapper = new SdkUiStreamMapper();

  try {
    const stream = createUIMessageStream({
      onError: input.onError,
      execute: async ({ writer }) => {
        // The finally guarantees the slot is freed on success, SDK error, AND
        // client abort (the for-await unwinds when the controller aborts).
        try {
          writer.write(mapper.startChunk(crypto.randomUUID()));

          const response = query({
            prompt: input.prompt,
            options: {
              pathToClaudeCodeExecutable: binary,
              env: buildClaudeSdkEnv({
                baseUrl: input.gatewayBaseUrl,
                placeholderToken: input.placeholderToken,
              }),
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
            logger.warn("claude-agent chat turn ended in error", {
              finishReason: meta.finishReason,
            });
            writer.write({ type: "error", errorText: meta.errorText ?? input.onError(undefined) });
          }
          writer.write(mapper.finishChunk());
        } finally {
          clearTimeout(deadline);
          slot.release();
        }
      },
    });

    return createUIMessageStreamResponse({ stream });
  } catch (err) {
    // `execute` runs lazily on stream consumption, so a synchronous throw from
    // stream/Response construction means its finally never fires — release the
    // slot + clear the deadline here so a thrown setup can't leak capacity.
    clearTimeout(deadline);
    slot.release();
    throw err;
  }
}
