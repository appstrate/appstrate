// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation's tool calls, read from its stored messages, for the context panel: what the
 * assistant did, in order, and the integrations it reached. Pure, like `conversationStats`.
 *
 * A stored message keeps each call's input, output and error, not its timing (assistant-ui
 * measures that live, in the browser), so no duration is derived here.
 */

import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { asRecordOrNull } from "@appstrate/core/safe-json";
import { unwrapMcpResult } from "@appstrate/core/mcp-result";
import { deriveToolPhase, extractErrorMessage } from "./tool-result.ts";
import { presentationOf } from "./tool-presentation.ts";
import type { PresentationSubject } from "@appstrate/core/mcp-presentation";
import { callSpaceOf } from "./conversation-scope.ts";

export type ConversationToolStatus = "running" | "success" | "error" | "denied";

export interface ConversationToolCall {
  toolCallId: string;
  /** The assistant message holding the call. */
  messageId: string;
  /** 1-based: the conversation's assistant turn the call belongs to. */
  turn: number;
  toolName: string;
  input: unknown;
  /** The unwrapped result, absent while the call runs or when it failed without one. */
  output: unknown;
  /** The result as persisted, with the platform's presentation beside it (`showCall`). */
  result: unknown;
  status: ConversationToolStatus;
  /** What a failed call says, from its error text or its failure payload. */
  error?: string;
  /**
   * A lookup, as the engine stamped it before the call ran (`providerMetadata.appstrate.lookup`,
   * the stamp the thread folds reads by): counted, kept apart from the actions.
   */
  lookup: boolean;
  /** The integration the call reached, as the platform presented it. */
  integration?: PresentationSubject;
  /** The space the call acted in, stamped on it by the chat. */
  spaceId?: string;
}

export interface ConversationIntegrationUse {
  integration: PresentationSubject;
  calls: number;
}

export interface ConversationTools {
  /** In conversation order. */
  calls: ConversationToolCall[];
  /** The integrations the calls reached, in order of first use. */
  integrations: ConversationIntegrationUse[];
}

/** The engine's lookup stamp on a call (`pi-chat/ui-stream-mapper.ts`). */
function isLookupStamped(metadata: unknown): boolean {
  return asRecordOrNull(asRecordOrNull(metadata)?.appstrate)?.lookup === true;
}

type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;

function statusOf(part: ToolPart, output: unknown, running: boolean): ConversationToolStatus {
  switch (part.state) {
    case "output-denied":
      return "denied";
    case "output-error":
      return "error";
    case "output-available":
      return deriveToolPhase({ status: { type: "complete" }, result: output }) === "error"
        ? "error"
        : "success";
    default:
      // A call with no outcome is running only in the turn still being generated: a closed turn
      // that kept one was cut short.
      return running ? "running" : "error";
  }
}

/**
 * The calls of `messages`, in order. `generating`: the conversation's last turn is still being
 * generated, so its calls with no outcome yet are running.
 */
export function conversationTools(
  messages: readonly UIMessage[],
  generating = false,
): ConversationTools {
  const calls: ConversationToolCall[] = [];
  let lastAssistant = -1;
  messages.forEach((message, index) => {
    if (message.role === "assistant") lastAssistant = index;
  });
  let turn = 0;

  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    turn += 1;
    const running = generating && index === lastAssistant;
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      const toolName = getToolName(part);
      const output = "output" in part ? unwrapMcpResult(part.output) : undefined;
      const status = statusOf(part, output, running);
      const error =
        status !== "error"
          ? undefined
          : (("errorText" in part ? part.errorText : undefined) ?? extractErrorMessage(output));
      const result = "output" in part ? part.output : undefined;
      const subject = presentationOf(result)?.subject;
      const integration = subject?.kind === "integration" ? subject : undefined;
      const spaceId = callSpaceOf({ providerMetadata: part.callProviderMetadata, result });
      calls.push({
        toolCallId: part.toolCallId,
        messageId: message.id,
        turn,
        toolName,
        input: part.input,
        output,
        result,
        status,
        ...(error ? { error } : {}),
        lookup: isLookupStamped(part.callProviderMetadata),
        ...(integration ? { integration } : {}),
        ...(spaceId ? { spaceId } : {}),
      });
    }
  });

  const integrations = new Map<string, ConversationIntegrationUse>();
  for (const call of calls) {
    if (!call.integration) continue;
    const use = integrations.get(call.integration.id) ?? {
      integration: call.integration,
      calls: 0,
    };
    use.calls += 1;
    integrations.set(call.integration.id, use);
  }
  return { calls, integrations: [...integrations.values()] };
}

/**
 * Bring a call's card into view in the thread and give it focus, falling back to the message that
 * holds it (a card drawn without the anchor). False when neither is on the page.
 */
export function revealToolCall(
  call: Pick<ConversationToolCall, "toolCallId" | "messageId">,
): boolean {
  const thread = document.querySelector("[data-chat-thread]");
  if (!thread) return false;
  const target =
    thread.querySelector<HTMLElement>(`[data-tool-call-id="${CSS.escape(call.toolCallId)}"]`) ??
    thread.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(call.messageId)}"]`);
  if (!target) return false;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  // A focus moved by script draws no ring: a short outline marks where the eye should land.
  target.animate([{ boxShadow: "0 0 0 2px var(--ring)" }, { boxShadow: "0 0 0 2px transparent" }], {
    duration: 1600,
    easing: "ease-out",
  });
  // The card's own control takes the focus: a keyboard reader lands where the eye does.
  (target.querySelector<HTMLElement>("button, a[href]") ?? target).focus({ preventScroll: true });
  return true;
}
