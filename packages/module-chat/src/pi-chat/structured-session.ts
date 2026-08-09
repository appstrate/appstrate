// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministically project Appstrate's canonical active UIMessage branch into
 * a disposable Pi session. Appstrate remains the only durable history. Every
 * turn rebuilds SessionManager.inMemory(), so a server restart, branch switch
 * or model change cannot reuse stale derived state and no Pi JSONL is written.
 */

import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { Api, Message } from "@appstrate/runner-pi";
import { messagesWithAttachmentsAsText } from "../attachments.ts";
import { redactConnectPayload, splitJsonText } from "../connect-offer.ts";
import { uiMessageText } from "../message-text.ts";

export interface PiHistoryModel {
  api: Api;
  provider: string;
  model: string;
}

export interface StructuredPiTurn {
  history: Message[];
  prompt: string;
  branchHeadId: string;
  sourceMessageCount: number;
  toolCallCount: number;
  toolResultCount: number;
}

interface SessionManagerLike {
  appendMessage(message: Message): string;
  buildSessionContext(): { messages: unknown[] };
  getSessionFile(): string | undefined;
}

interface SessionManagerFactory<T extends SessionManagerLike> {
  inMemory(cwd?: string): T;
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return value === undefined ? {} : { value };
}

function json(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function toolResultContent(value: unknown): Array<{ type: "text"; text: string }> {
  if (value && typeof value === "object") {
    const content = (value as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content.flatMap((part) => {
        if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "text") {
          return [];
        }
        return [
          {
            type: "text" as const,
            text: splitJsonText(String((part as { text?: unknown }).text ?? "")).text,
          },
        ];
      });
      if (text.length > 0) return text;
    }
  }
  return [{ type: "text", text: json(redactConnectPayload(value)) }];
}

function userMessage(message: UIMessage, timestamp: number): Message | null {
  const content = message.parts.flatMap((part) =>
    part.type === "text" && part.text.length > 0
      ? [{ type: "text" as const, text: part.text }]
      : [],
  );
  if (content.length === 0) return null;
  return { role: "user", content, timestamp };
}

function assistantMessages(
  message: UIMessage,
  model: PiHistoryModel,
  baseTimestamp: number,
): { messages: Message[]; toolCallCount: number; toolResultCount: number } {
  const output: Message[] = [];
  let segment: UIMessage["parts"] = [];
  let timestamp = baseTimestamp;
  let toolCallCount = 0;
  let toolResultCount = 0;

  const flush = () => {
    if (segment.length === 0) return;
    const content: Array<
      | { type: "text"; text: string }
      | { type: "thinking"; thinking: string }
      | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
    > = [];
    const results: Message[] = [];

    for (const part of segment) {
      if (part.type === "text" && part.text.length > 0) {
        content.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "reasoning" && part.text.length > 0) {
        content.push({ type: "thinking", thinking: part.text });
        continue;
      }
      if (!isToolUIPart(part)) continue;

      const toolName = getToolName(part);
      content.push({
        type: "toolCall",
        id: part.toolCallId,
        name: toolName,
        arguments: record(part.input),
      });
      toolCallCount += 1;

      let result: unknown;
      let isError = false;
      if (part.state === "output-available") {
        result = part.output;
      } else if (part.state === "output-error") {
        result = part.errorText;
        isError = true;
      } else if (part.state === "output-denied") {
        result = part.approval.reason ?? "Tool execution was denied.";
        isError = true;
      } else {
        result = "Tool call did not complete before persistence.";
        isError = true;
      }
      results.push({
        role: "toolResult",
        toolCallId: part.toolCallId,
        toolName,
        content: toolResultContent(result),
        isError,
        timestamp: ++timestamp,
      });
      toolResultCount += 1;
    }

    if (content.length > 0) {
      output.push({
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.model,
        usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
        stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
        timestamp: ++timestamp,
      });
      output.push(...results);
    }
    segment = [];
  };

  for (const part of message.parts) {
    if (part.type === "step-start") flush();
    else segment.push(part);
  }
  flush();

  return { messages: output, toolCallCount, toolResultCount };
}

/** Convert the active branch history and keep its final user message as the new prompt. */
export function buildStructuredPiTurn(input: UIMessage[], model: PiHistoryModel): StructuredPiTurn {
  const messages = messagesWithAttachmentsAsText(input);
  const last = messages.at(-1);
  if (!last || last.role !== "user") {
    throw new Error("The active Pi chat branch must end with a user message.");
  }

  const history: Message[] = [];
  let toolCallCount = 0;
  let toolResultCount = 0;
  for (const [index, message] of messages.slice(0, -1).entries()) {
    if (message.role === "user") {
      const converted = userMessage(message, index + 1);
      if (converted) history.push(converted);
      continue;
    }
    if (message.role === "assistant") {
      const converted = assistantMessages(message, model, (index + 1) * 100);
      history.push(...converted.messages);
      toolCallCount += converted.toolCallCount;
      toolResultCount += converted.toolResultCount;
    }
  }

  return {
    history,
    prompt: uiMessageText(last.parts),
    branchHeadId: last.id,
    sourceMessageCount: messages.length - 1,
    toolCallCount,
    toolResultCount,
  };
}

/** Reconstruct a disposable Pi session without creating a second durable history. */
export function reconstructPiSession<T extends SessionManagerLike>(
  SessionManager: SessionManagerFactory<T>,
  history: Message[],
): T {
  const session = SessionManager.inMemory("/tmp");
  for (const message of history) session.appendMessage(message);
  return session;
}
