// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation's tool calls, for the context panel, in order: pure, like `conversationStats`. It
 * reads the messages the open chat holds (`live-conversation.ts`), the turn in flight included.
 * What counts as a lookup lives here too, for the panel and the thread's activity group.
 */

import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { unwrapMcpResult } from "@appstrate/core/mcp-result";
import type { ToolPresentation } from "@appstrate/core/mcp-presentation";
import { deriveToolPhase, extractErrorMessage } from "./tool-result.ts";
import { callOutcome, callPresentation } from "./tool-presentation.ts";
import { callSpaceOf } from "./conversation-scope.ts";
import { extractRunId } from "./run-events.ts";
import type { ChatTranslate } from "./runtime-context.ts";

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

/** The engine stamped the call a lookup before it ran (`appstrate.lookup`, `ui-stream-mapper.ts`). */
function stampedLookup(callMetadata: unknown): boolean {
  return (
    (callMetadata as { appstrate?: { lookup?: unknown } } | undefined)?.appstrate?.lookup === true
  );
}

export interface GroupablePart {
  readonly type: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly providerMetadata?: unknown;
  readonly status?: { readonly type: string } | undefined;
  readonly result?: unknown;
  readonly isError?: boolean | undefined;
}

/**
 * Tools whose call is a card of its own in the thread, never a step of an activity group: the
 * card is the call's whole display (a run's progress).
 */
const STANDALONE_TOOLS: ReadonlySet<string> = new Set(["run_and_wait"]);

/**
 * The thread's group path of an assistant part (`groupBy`, drawn by `activity-group.tsx`):
 * reasoning and tool calls that follow one another are one activity, which a text part ends. A
 * call joins on its tool's name, known from its first chunk, so no step moves once drawn.
 */
export function activityGroupOf(
  part: GroupablePart,
): readonly ("group-activity" | "group-reasoning")[] | null {
  if (part.type === "reasoning") return ["group-activity", "group-reasoning"];
  if (part.type === "tool-call" && !STANDALONE_TOOLS.has(part.toolName ?? "")) {
    return ["group-activity"];
  }
  return null;
}

/** The tool calls among `parts` at `indices`: the steps an activity group counts. */
export function callsAt<P extends GroupablePart>(
  parts: readonly P[],
  indices: readonly number[],
): P[] {
  return indices.flatMap((i) => {
    const part = parts[i];
    return part?.type === "tool-call" && part.toolCallId ? [part] : [];
  });
}

/**
 * Tool calls counted as the thread's group header and the context panel's turn heading say them:
 * « 3 consultations · 1 action », a zero part left out.
 */
export function activityCounts(
  t: ChatTranslate,
  { lookups, actions }: { lookups: number; actions: number },
): string {
  return [
    lookups > 0 ? t("tool.reads.done", { count: lookups }) : null,
    actions > 0 ? t("tool.actions.done", { count: actions }) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** The engine stamped the part's call a lookup: counted as a consultation, the others as actions. */
export function isStampedLookup(part: GroupablePart): boolean {
  return stampedLookup(part.providerMetadata);
}

/** The message ends in an activity group, whose header then carries the turn's status region. */
export function endsInActivity(parts: readonly GroupablePart[]): boolean {
  const last = parts[parts.length - 1];
  return last !== undefined && activityGroupOf(last) !== null;
}

/** A lookup, unless it failed: a stamped one, or presented as a read once its result landed. */
export function isLookupCall(
  callMetadata: unknown,
  presentation: ToolPresentation | undefined,
  status: ConversationToolStatus,
): boolean {
  if (status === "error" || status === "denied") return false;
  if (stampedLookup(callMetadata)) return true;
  const method = presentation?.method?.toUpperCase();
  return method === "GET" || method === "HEAD";
}

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

/** A turn streams by replacing its last message only: a finished one is derived once. */
const byMessage = new WeakMap<
  UIMessage,
  { turn: number; turnRuns: boolean; calls: ConversationToolCall[] }
>();

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

/** The calls of `messages`, in order. `running`: the last message is the turn in flight. */
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
