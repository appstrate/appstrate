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
import { isLookupCall } from "./tool-presentation.ts";
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
  status: ConversationToolStatus;
  /** What a failed call says, from its error text or its failure payload. */
  error?: string;
  /** Read-only: counted, kept apart from the actions. */
  lookup: boolean;
  /** The integration a `call_integration_tool` reached, when a `search` of the conversation named it. */
  integrationPackageId?: string;
  /** The space the call acted in, stamped on it by the chat. */
  spaceId?: string;
}

export interface ConversationIntegrationUse {
  packageId: string;
  calls: number;
}

export interface ConversationTools {
  /** In conversation order. */
  calls: ConversationToolCall[];
  /** The integrations the calls reached, in order of first use. */
  integrations: ConversationIntegrationUse[];
}

type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;

/**
 * Every integration tool a `search` or `describe` listed: its `id` (what `call_integration_tool`
 * takes as `tool`) to the integration it belongs to. The id is a lossy namespace
 * (`scope_name__tool`), so the listing is the only exact source of the package.
 */
function collectIntegrationToolIds(value: unknown, into: Map<string, string>, depth = 0): void {
  if (depth > 6 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectIntegrationToolIds(item, into, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && typeof record.integration_package_id === "string") {
    into.set(record.id, record.integration_package_id);
  }
  for (const child of Object.values(record)) collectIntegrationToolIds(child, into, depth + 1);
}

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
  const listed = new Map<string, string>();
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
      if (toolName === "search" || toolName === "describe") {
        collectIntegrationToolIds(output, listed);
      }
      const status = statusOf(part, output, running);
      const error =
        status !== "error"
          ? undefined
          : (("errorText" in part ? part.errorText : undefined) ?? extractErrorMessage(output));
      const tool = toolName === "call_integration_tool" ? asRecordOrNull(part.input)?.tool : null;
      const integrationPackageId = typeof tool === "string" ? listed.get(tool) : undefined;
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
        status,
        ...(error ? { error } : {}),
        lookup: isLookupCall(toolName, part.input),
        ...(integrationPackageId ? { integrationPackageId } : {}),
        ...(spaceId ? { spaceId } : {}),
      });
    }
  });

  const integrations = new Map<string, ConversationIntegrationUse>();
  for (const call of calls) {
    if (!call.integrationPackageId) continue;
    const use = integrations.get(call.integrationPackageId) ?? {
      packageId: call.integrationPackageId,
      calls: 0,
    };
    use.calls += 1;
    integrations.set(call.integrationPackageId, use);
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
