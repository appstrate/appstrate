// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministically project Appstrate's canonical active UIMessage branch into
 * a disposable Pi session. Appstrate remains the only durable history. Every
 * turn rebuilds SessionManager.inMemory(), so a server restart, branch switch
 * or model change cannot reuse stale derived state and no Pi JSONL is written.
 *
 * The projection stays deliberately thin: where Pi's own request transform
 * already normalizes something, this file hands it the raw shape rather than
 * pre-chewing it. Orphaned tool calls, cross-model tool-call ids and unsigned
 * reasoning are all Pi's job (`pi-ai/dist/api/transform-messages.js`), and
 * reimplementing them here would only let the two drift.
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

/** Estimate the tokens one Pi message occupies — Pi's own exported heuristic. */
export type EstimateTokens = (message: Message) => number;

export interface BuildStructuredPiTurnOptions {
  estimateTokens: EstimateTokens;
  /**
   * Tokens the request carries before any history: the system prompt. Tool
   * schemas are NOT included (their serialized size is Pi's to know, not ours),
   * so the figure is a floor, not a measurement.
   */
  baseTokens: number;
}

interface StructuredPiTurn {
  history: Message[];
  prompt: string;
  branchHeadId: string;
  sourceMessageCount: number;
  toolCallCount: number;
  toolResultCount: number;
  contextTokens: number;
}

interface SessionManagerLike {
  appendMessage(message: Message): string;
  buildSessionContext(): { messages: unknown[] };
  getSessionFile(): string | undefined;
}

interface SessionManagerFactory<T extends SessionManagerLike> {
  inMemory(cwd?: string): T;
}

type AssistantMessage = Extract<Message, { role: "assistant" }>;
type ToolResultMessage = Extract<Message, { role: "toolResult" }>;
type ToolResultContent = ToolResultMessage["content"];

/**
 * Historical assistant messages are NOT attributed to the model running this
 * turn. Appstrate does not persist which model produced a given response, and
 * claiming the current one makes Pi's `isSameModel` test pass for history it
 * never produced — which suppresses cross-model tool-call id normalization
 * (`transform-messages.js`, where a 450-char Codex `fc_…|…` id would otherwise
 * be rewritten to satisfy Anthropic's 64-char `^[a-zA-Z0-9_-]+$` rule) and
 * defeats the Responses API's function-call/reasoning pairing guard.
 *
 * The sentinel replaces the model id only. `api` and `provider` stay truthful
 * so the Responses path lands on its `isDifferentModel` branch — the one
 * written to scrub unpaired item ids — rather than the weaker cross-provider
 * path that leaves `fc_` ids intact.
 */
const HISTORY_MODEL_SENTINEL = "appstrate-history";

function historyUsage(contextTokens: number): AssistantMessage["usage"] {
  return {
    input: contextTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: contextTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Pi stamps `Message.timestamp` with epoch milliseconds and compares assistant
 * timestamps against its own compaction entries. The canonical branch carries
 * no per-message time, so mint a monotonic sequence at projection time — the
 * same thing Pi does for the tool results it synthesizes. Ordering inside the
 * disposable session comes from the entry tree, not from these values.
 */
function projectionClock(): () => number {
  let next = Date.now();
  return () => next++;
}

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

/**
 * Convert one tool output into Pi tool-result content. Image blocks are carried
 * through as `ImageContent` (Pi serializes them natively) instead of being
 * JSON-stringified — a base64 payload inlined into a text block would be both
 * useless to the model and a context bomb.
 */
function toolResultContent(value: unknown): ToolResultContent {
  if (value && typeof value === "object") {
    const content = (value as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const blocks = content.flatMap((part): ToolResultContent => {
        if (!part || typeof part !== "object") return [];
        const type = (part as { type?: unknown }).type;
        if (type === "text") {
          return [
            {
              type: "text",
              text: splitJsonText(String((part as { text?: unknown }).text ?? "")).text,
            },
          ];
        }
        if (type === "image") {
          const { data, mimeType } = part as { data?: unknown; mimeType?: unknown };
          if (typeof data === "string" && typeof mimeType === "string") {
            return [{ type: "image", data, mimeType }];
          }
        }
        return [];
      });
      if (blocks.length > 0) return blocks;
    }
  }
  return [{ type: "text", text: json(redactConnectPayload(value)) }];
}

function userMessage(message: UIMessage, nextTimestamp: () => number): Message | null {
  const content = message.parts.flatMap((part) =>
    part.type === "text" && part.text.length > 0
      ? [{ type: "text" as const, text: part.text }]
      : [],
  );
  if (content.length === 0) return null;
  return { role: "user", content, timestamp: nextTimestamp() };
}

function assistantMessages(
  message: UIMessage,
  model: PiHistoryModel,
  nextTimestamp: () => number,
): { messages: Message[]; toolCallCount: number; toolResultCount: number } {
  const output: Message[] = [];
  let segment: UIMessage["parts"] = [];
  let toolCallCount = 0;
  let toolResultCount = 0;

  const flush = () => {
    if (segment.length === 0) return;
    const content: Array<
      | { type: "text"; text: string }
      | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
    > = [];
    const results: Array<Omit<ToolResultMessage, "timestamp">> = [];

    for (const part of segment) {
      if (part.type === "text" && part.text.length > 0) {
        content.push({ type: "text", text: part.text });
        continue;
      }
      // `reasoning` parts are deliberately NOT projected. Appstrate never
      // persists the opaque `thinkingSignature` that makes a thinking block
      // replayable, and without it Pi downgrades the block to plain assistant
      // text on the Anthropic path and drops it outright on the Responses one.
      // Neither restores thinking continuity; replaying the text only re-bills
      // private reasoning as public prose on every later turn.
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
      let isError: boolean;
      if (part.state === "output-available") {
        result = part.output;
        isError = false;
      } else if (part.state === "output-error") {
        result = part.errorText;
        isError = true;
      } else if (part.state === "output-denied") {
        result = part.approval.reason ?? "Tool execution was denied.";
        isError = true;
      } else {
        // The turn died before this call produced anything. Emit the call with
        // NO result: Pi's request transform synthesizes the missing result for
        // an orphaned tool call itself, and duplicating that here would be one
        // more thing to keep in sync with the SDK.
        continue;
      }
      results.push({
        role: "toolResult",
        toolCallId: part.toolCallId,
        toolName,
        content: toolResultContent(result),
        isError,
      });
      toolResultCount += 1;
    }

    if (content.length > 0) {
      output.push({
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: HISTORY_MODEL_SENTINEL,
        usage: historyUsage(0),
        stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
        timestamp: nextTimestamp(),
      });
      for (const result of results) output.push({ ...result, timestamp: nextTimestamp() });
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

/**
 * Convert the active branch history and keep its final user message as the new
 * prompt.
 *
 * Every historical turn is projected, including a user request that no model
 * output ever answered (a cancelled turn, a provider failure persisted as
 * metadata with no parts). Dropping those was considered and rejected: it
 * destroys the referent of the retry — "Réessaie" with the question deleted is
 * unanswerable — and the alternation it was meant to protect is not a real
 * constraint. Anthropic combines consecutive same-role turns into one
 * (`@anthropic-ai/sdk` `MessageCreateParams.messages`), and the Responses API
 * takes a flat item list with no alternation rule at all.
 */
export function buildStructuredPiTurn(
  input: UIMessage[],
  model: PiHistoryModel,
  { estimateTokens, baseTokens }: BuildStructuredPiTurnOptions,
): StructuredPiTurn {
  const messages = messagesWithAttachmentsAsText(input);
  const last = messages.at(-1);
  if (!last || last.role !== "user") {
    throw new Error("The active Pi chat branch must end with a user message.");
  }

  const nextTimestamp = projectionClock();
  const history: Message[] = [];
  let toolCallCount = 0;
  let toolResultCount = 0;
  for (const message of messages.slice(0, -1)) {
    if (message.role === "user") {
      const converted = userMessage(message, nextTimestamp);
      if (converted) history.push(converted);
      continue;
    }
    if (message.role !== "assistant") continue;
    const converted = assistantMessages(message, model, nextTimestamp);
    history.push(...converted.messages);
    toolCallCount += converted.toolCallCount;
    toolResultCount += converted.toolResultCount;
  }

  // Pi reads its compaction threshold off the usage carried by the newest
  // assistant message it can see, falling back to its own estimate only when
  // there is none. A projected history reporting zero would make an
  // arbitrarily long thread look empty to that check, so each assistant
  // carries the running estimate of everything up to it. The real usage of
  // this turn's own responses overwrites it as soon as it arrives.
  let contextTokens = baseTokens;
  for (const message of history) {
    contextTokens += estimateTokens(message);
    if (message.role === "assistant") message.usage = historyUsage(contextTokens);
  }

  return {
    history,
    prompt: uiMessageText(last.parts),
    branchHeadId: last.id,
    sourceMessageCount: messages.length - 1,
    toolCallCount,
    toolResultCount,
    contextTokens,
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
