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

import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { buildClaudeSdkEnv, CLAUDE_SDK_HARDENING } from "@appstrate/runner-claude/binary";
import { RUN_AND_WAIT_MAX_MS } from "@appstrate/core/run-and-wait-client";
import {
  CHAT_MAX_STEPS,
  CHAT_TOOL_STEP_BUDGET,
  CHAT_TOOL_STEP_BUDGET_DENIAL,
  mergeTurnMetadata,
} from "@appstrate/core/chat-turn-metadata";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { createLogger } from "@appstrate/core/logger";
import type { ChatEngineInput } from "@appstrate/core/chat-engine-contract";
import { resolveClaudeCodeBinary } from "./binary.ts";
import { SdkUiStreamMapper, type ClaudeSdkMessage } from "./ui-stream-mapper.ts";
import { acquireClaudeSlot, chatCapacityResponse } from "./concurrency.ts";
import {
  createRunAndWaitBridge,
  RUN_AND_WAIT_MCP_QUALIFIED_TOOL_NAME,
  RUN_AND_WAIT_MCP_SERVER_NAME,
} from "./run-and-wait-bridge.ts";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

/**
 * Wall-clock deadline for one chat turn. `maxTurns` bounds the agent loop, but a
 * single turn wedged on a stuck upstream or a hung MCP call would otherwise hold
 * the `claude` subprocess + a concurrency slot open indefinitely. On the deadline
 * we abort the controller (kills the subprocess, frees the slot via the finally).
 */
const TURN_DEADLINE_MS = RUN_AND_WAIT_MAX_MS + 15_000;

/**
 * Build the `mcpServers` config: the platform HTTP MCP when available, else
 * none. (Typed loosely — the SDK's McpServerConfig union is broad and not
 * re-exported conveniently.)
 */
function buildMcpServers(
  input: ChatEngineInput,
  runAndWaitServer: unknown | undefined,
): Record<string, unknown> | undefined {
  const servers: Record<string, unknown> = {};
  if (input.platformMcp) {
    servers.platform = {
      type: "http",
      url: input.platformMcp.url,
      headers: input.platformMcp.headers,
    };
  }
  if (runAndWaitServer) servers[RUN_AND_WAIT_MCP_SERVER_NAME] = runAndWaitServer;
  return Object.keys(servers).length > 0 ? servers : undefined;
}

interface RunAndWaitPermissionBridge {
  handleToolPermission(
    toolName: string,
    input: Record<string, unknown>,
    toolUseID: string | undefined,
  ): void;
}

interface ToolTurnBudget {
  currentTurnCount: () => number;
  markToolStepBudgetReached: () => void;
}

export function buildRunAndWaitCanUseTool(
  runAndWaitBridge: RunAndWaitPermissionBridge | null,
  budget: ToolTurnBudget,
): CanUseTool | undefined {
  if (!runAndWaitBridge) return undefined;
  return async (toolName, toolInput, options) => {
    // The Claude Agent SDK cannot hide MCP tools for a specific turn before
    // generation. Deny the first tool request on the reserved final-tool-budget
    // turn so the denial is fed back and the remaining turn can produce text.
    if (budget.currentTurnCount() >= CHAT_TOOL_STEP_BUDGET) {
      budget.markToolStepBudgetReached();
      return {
        behavior: "deny",
        message: CHAT_TOOL_STEP_BUDGET_DENIAL,
        toolUseID: options.toolUseID,
      };
    }
    runAndWaitBridge.handleToolPermission(toolName, toolInput, options.toolUseID);
    return { behavior: "allow", toolUseID: options.toolUseID };
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
  if (!slot) return chatCapacityResponse();

  const controller = new AbortController();
  if (input.abortSignal.aborted) controller.abort();
  else input.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });

  // Wall-clock deadline: abort a turn wedged on a stuck upstream/MCP so it can't
  // pin the subprocess + slot open. Unref'd so it never keeps the process alive;
  // cleared in the execute finally on normal completion.
  const deadline = setTimeout(() => controller.abort(), TURN_DEADLINE_MS);
  (deadline as unknown as { unref?: () => void }).unref?.();

  const mapper = new SdkUiStreamMapper();
  let toolStepBudgetReached = false;

  try {
    const stream = createUIMessageStream({
      onError: input.onError,
      execute: async ({ writer }) => {
        // The finally guarantees the slot is freed on success, SDK error, AND
        // client abort (the for-await unwinds when the controller aborts).
        try {
          writer.write(mapper.startChunk(crypto.randomUUID()));
          const runAndWaitBridge = input.platformMcp
            ? createRunAndWaitBridge({
                origin: new URL(input.platformMcp.url).origin,
                headers: input.platformMcp.headers,
                fetch,
                signal: controller.signal,
                write: (chunk) => writer.write(chunk),
              })
            : null;

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
              mcpServers: buildMcpServers(input, runAndWaitBridge?.mcpServer) as never,
              canUseTool: buildRunAndWaitCanUseTool(runAndWaitBridge, {
                currentTurnCount: () => mapper.stepCount(),
                markToolStepBudgetReached: () => {
                  toolStepBudgetReached = true;
                },
              }),
              disallowedTools: runAndWaitBridge ? ["mcp__platform__run_and_wait"] : undefined,
              toolAliases: runAndWaitBridge
                ? {
                    run_and_wait: RUN_AND_WAIT_MCP_QUALIFIED_TOOL_NAME,
                    mcp__platform__run_and_wait: RUN_AND_WAIT_MCP_QUALIFIED_TOOL_NAME,
                  }
                : undefined,
              includePartialMessages: true,
              ...CLAUDE_SDK_HARDENING,
              maxTurns: CHAT_MAX_STEPS,
              abortController: controller,
            },
          });

          for await (const message of response) {
            for (const chunk of mapper.map(message as ClaudeSdkMessage)) {
              writer.write(chunk);
            }
          }

          const meta = mapper.resultMeta();
          if (meta?.isError) {
            logger.warn("claude-agent chat turn ended in error", {
              finishReason: meta.finishReason,
            });
            writer.write({ type: "error", errorText: meta.errorText ?? input.onError(undefined) });
          }
          writer.write(
            mapper.finishChunk(
              mergeTurnMetadata(
                meta ? { usage: meta.usage, costUsd: meta.totalCostUsd } : undefined,
                {
                  engine: "subscription",
                  finishReason: meta?.finishReason ?? "unknown",
                  stepCount: mapper.stepCount(),
                  maxSteps: CHAT_MAX_STEPS,
                  toolStepBudget: CHAT_TOOL_STEP_BUDGET,
                  toolStepBudgetReached,
                  maxStepsReached: mapper.stepCount() >= CHAT_MAX_STEPS,
                  ...(mapper.lastToolName() ? { lastToolName: mapper.lastToolName() } : {}),
                },
              ),
            ),
          );
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
