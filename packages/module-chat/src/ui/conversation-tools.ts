// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation's tool calls, read from its stored messages, for the context panel: what the
 * assistant did, in order, and the integrations it reached. Pure, like `conversationStats`.
 *
 * The stored messages hold the turns that ended: the assistant message is persisted when its turn
 * is finalized (`chat-stream.ts`), so a call stored without an outcome was cut short. A stored
 * message keeps each call's input, output and error, not its timing (assistant-ui measures that
 * live, in the browser), so no duration is derived here.
 */

import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { asRecordOrNull } from "@appstrate/core/safe-json";
import { unwrapMcpResult } from "@appstrate/core/mcp-result";
import type { PresentationSubject, ToolPresentation } from "@appstrate/core/mcp-presentation";
import { deriveToolPhase, extractErrorMessage } from "./tool-result.ts";
import { callPresentation } from "./tool-presentation.ts";
import { isLookupCall } from "./activity-group.ts";
import { callSpaceOf } from "./conversation-scope.ts";
import { extractRunId } from "./run-events.ts";

export type ConversationToolStatus = "success" | "error" | "denied";

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
  /** The integrations the calls reached, in order of first use. */
  integrations: PresentationSubject[];
}

type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;

function statusOf(part: ToolPart, output: unknown): ConversationToolStatus {
  switch (part.state) {
    case "output-denied":
      return "denied";
    case "output-available":
      return deriveToolPhase({ status: { type: "complete" }, result: output }) === "error"
        ? "error"
        : "success";
    default:
      // `output-error`, or no outcome: a stored turn that kept a call without one was cut short.
      return "error";
  }
}

/**
 * The platform's own refusal: a result it answered without relaying the integration's (a
 * `{ code, … }` payload not marked relayed), as a refused argument or a missing connection is.
 */
function isPlatformRefusal(result: unknown): boolean {
  if (asRecordOrNull(result)?.relayed === true) return false;
  return typeof asRecordOrNull(unwrapMcpResult(result))?.code === "string";
}

/**
 * The integration a call reached: a `call_integration_tool` the platform presented under its
 * integration, that the integration answered, with a success or its own failure. A denied call, a
 * refusal of the platform and an operation (`invoke_operation`) reached none.
 */
function reachedIntegration(
  part: ToolPart,
  toolName: string,
  status: ConversationToolStatus,
  presentation: ToolPresentation | undefined,
): PresentationSubject | undefined {
  const subject = presentation?.subject;
  if (toolName !== "call_integration_tool" || subject?.kind !== "integration") return undefined;
  if (status === "denied") return undefined;
  if (part.state === "output-available" && isPlatformRefusal(part.output)) return undefined;
  return subject;
}

/** The calls of `messages`, in order, and the integrations they reached. */
export function conversationTools(messages: readonly UIMessage[]): ConversationTools {
  const calls: ConversationToolCall[] = [];
  const integrations = new Map<string, PresentationSubject>();
  let turn = 0;

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    turn += 1;
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      const toolName = getToolName(part);
      const output = "output" in part ? unwrapMcpResult(part.output) : undefined;
      const status = statusOf(part, output);
      const error =
        status !== "error"
          ? undefined
          : (("errorText" in part ? part.errorText : undefined) ?? extractErrorMessage(output));
      const presentation = callPresentation(part);
      const runId = "output" in part ? extractRunId(part.output) : undefined;
      const spaceId = callSpaceOf({
        providerMetadata: part.callProviderMetadata,
        result: "output" in part ? part.output : undefined,
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
        lookup: isLookupCall(part.callProviderMetadata, status),
        ...(spaceId ? { spaceId } : {}),
        ...(runId ? { runId } : {}),
      });
      const reached = reachedIntegration(part, toolName, status, presentation);
      if (reached && !integrations.has(reached.id)) integrations.set(reached.id, reached);
    }
  }
  return { calls, integrations: [...integrations.values()] };
}
