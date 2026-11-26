// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation's tool calls, for the context panel: what the assistant did, in order. Pure, like `conversationStats`.
 *
 * It reads the conversation's messages as the open chat holds them (`live-conversation.ts`): its
 * history and the turn in flight. A call without an outcome is running while its turn runs;
 * in a turn that ended it was cut short. What a call's outcome says beyond its output is read off
 * the stamp the engine put on it (`callOutcome`, `pi-chat/ui-stream-mapper.ts`), on a success and
 * on a failure alike: its presentation, how long it ran.
 */

import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { unwrapMcpResult } from "@appstrate/core/mcp-result";
import type { ToolPresentation } from "@appstrate/core/mcp-presentation";
import { deriveToolPhase, extractErrorMessage } from "./tool-result.ts";
import { callOutcome, callPresentation } from "./tool-presentation.ts";
import { isLookupCall } from "./activity-group.ts";
import { callSpaceOf } from "./conversation-scope.ts";
import { extractRunId } from "./run-events.ts";

/** `running` only while the call's turn runs: a call left without an outcome after it failed. */
export type ConversationToolStatus = "running" | "success" | "error" | "denied";

export interface ConversationToolCall {
  toolCallId: string;
  /** The assistant message holding the call. */
  messageId: string;
  /** 1-based: the conversation's assistant turn the call belongs to. */
  turn: number;
  toolName: string;
  input: unknown;
  /** The unwrapped result, absent when the call failed without one. */
  output: unknown;
  /** How the platform presented the call (`callPresentation`), for `showCall`. */
  presentation?: ToolPresentation;
  status: ConversationToolStatus;
  /** What a failed call says, from its error text or its failure payload. */
  error?: string;
  /** How long the tool ran, as the engine measured it. Absent while it runs. */
  durationMs?: number;
  /** A lookup ({@link isLookupCall}): counted, kept apart from the actions. False once it failed. */
  lookup: boolean;
  /** The space the call acted in, stamped on it by the chat. */
  spaceId?: string;
  /** The run the call launched, read off its result (`extractRunId`). */
  runId?: string;
}

export interface ConversationTools {
  /** In conversation order. */
  calls: ConversationToolCall[];
}

type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;

function statusOf(part: ToolPart, output: unknown, turnRuns: boolean): ConversationToolStatus {
  switch (part.state) {
    case "output-denied":
      return "denied";
    case "output-available":
      // A preliminary result (a run's progress) is not the call's outcome yet.
      if (part.preliminary === true) return turnRuns ? "running" : "error";
      return deriveToolPhase({ status: { type: "complete" }, result: output }) === "error"
        ? "error"
        : "success";
    case "output-error":
      return "error";
    default:
      // No outcome yet: running while its turn runs, cut short in a turn that ended.
      return turnRuns ? "running" : "error";
  }
}

/**
 * Each message's calls, kept while the message object is: a turn streams by replacing its last
 * message only, so a finished message is derived once and its calls keep their identity.
 */
const byMessage = new WeakMap<
  UIMessage,
  { turn: number; turnRuns: boolean; calls: ConversationToolCall[] }
>();

/** Each messages array's calls: the panel's readers of one frame share one derivation. */
const byMessages = new WeakMap<
  readonly UIMessage[],
  { running: boolean; tools: ConversationTools }
>();

function messageCalls(message: UIMessage, turn: number, turnRuns: boolean): ConversationToolCall[] {
  const cached = byMessage.get(message);
  if (cached && cached.turn === turn && cached.turnRuns === turnRuns) return cached.calls;
  const calls: ConversationToolCall[] = [];
  for (const part of message.parts) {
    if (!isToolUIPart(part)) continue;
    const toolName = getToolName(part);
    const output = "output" in part ? unwrapMcpResult(part.output) : undefined;
    const status = statusOf(part, output, turnRuns);
    const error =
      status !== "error"
        ? undefined
        : extractErrorMessage(part.state === "output-error" ? part.errorText : output);
    const presentation = callPresentation(part);
    const durationMs = callOutcome(part)?.durationMs;
    const runId = "output" in part ? extractRunId(part.output) : undefined;
    const spaceId = callSpaceOf({
      providerMetadata: part.callProviderMetadata,
      result: "output" in part ? part.output : undefined,
      resultProviderMetadata:
        "resultProviderMetadata" in part ? part.resultProviderMetadata : undefined,
    });
    calls.push({
      toolCallId: part.toolCallId,
      messageId: message.id,
      turn,
      toolName,
      input: part.input,
      output,
      ...(presentation ? { presentation } : {}),
      status,
      ...(error ? { error } : {}),
      ...(typeof durationMs === "number" ? { durationMs } : {}),
      lookup: isLookupCall(part.callProviderMetadata, presentation, status),
      ...(spaceId ? { spaceId } : {}),
      ...(runId ? { runId } : {}),
    });
  }
  byMessage.set(message, { turn, turnRuns, calls });
  return calls;
}

/**
 * The calls of `messages`, in order. `running`: the last message is the turn in flight.
 */
export function conversationTools(
  messages: readonly UIMessage[],
  { running = false }: { running?: boolean } = {},
): ConversationTools {
  const cached = byMessages.get(messages);
  if (cached && cached.running === running) return cached.tools;
  const calls: ConversationToolCall[] = [];
  let turn = 0;
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant") continue;
    turn += 1;
    calls.push(...messageCalls(message, turn, running && index === messages.length - 1));
  }
  const tools = { calls };
  byMessages.set(messages, { running, tools });
  return tools;
}
