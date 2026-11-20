// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministically project Appstrate's canonical active UIMessage branch into
 * a disposable Pi session. Appstrate remains the only durable history. Every
 * turn rebuilds SessionManager.inMemory() and no Pi JSONL is written. The one
 * derived state replayed is a summary Pi made on an earlier turn of the branch,
 * read back from that turn's metadata (`AppstrateTurnSummary`): the session
 * then starts with it and the history it kept, as Pi left it.
 *
 * The projection stays deliberately thin: where Pi's own request transform
 * already normalizes something, this file hands it the raw shape rather than
 * pre-chewing it. Orphaned tool calls, cross-model tool-call ids and unsigned
 * reasoning are all Pi's job (`pi-ai/dist/api/transform-messages.js`), and
 * reimplementing them here would only let the two drift.
 */

import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { z } from "zod";
import { FILE_URI_PREFIX } from "@appstrate/core/file-uri";
import {
  turnMetadataFromMessage,
  type AppstrateTurnSummary,
} from "@appstrate/core/chat-turn-metadata";
import type { Api, Message, PiCodingAgentSdk } from "@appstrate/runner-pi";
import { ZERO_MODEL_COST } from "@appstrate/runner-pi/model-compat";
import { messagesWithAttachmentsAsText } from "../attachments.ts";
import type { AttachmentImages, PiImageContent } from "./attachment-inputs.ts";
import { offerScopeOf, splitJsonText, type OfferScope } from "../connect-offer.ts";
import { logger } from "../logger.ts";
import { uiMessageText } from "../message-text.ts";
import { PI_CHAT_CWD } from "./resource-loader.ts";

export interface PiHistoryModel {
  api: Api;
  provider: string;
  model: string;
}

/** Estimate the tokens one Pi message occupies — Pi's own exported heuristic. */
type EstimateTokens = (message: Message) => number;

export interface BuildStructuredPiTurnOptions {
  estimateTokens: EstimateTokens;
  /**
   * Tokens the request carries before any history: the system prompt. Tool
   * schemas are NOT included (their serialized size is Pi's to know, not ours),
   * so the figure is a floor, not a measurement.
   */
  baseTokens: number;
  /**
   * The pixels of the attachments this request shows the model, by user message
   * id (`loadAttachmentImages`). Omitted = a model that sees no images: every
   * attachment stays its pointer line. Never persisted — rebuilt from the files
   * each turn.
   */
  images?: AttachmentImages;
  pdfReceipts?: ReadonlyMap<string, string>;
  /** Whether the model accepts image input, for the wording of the pointer lines. */
  modelSeesImages?: boolean;
  /** The branch's summary, validated ({@link resolveSummaryCheckpoint}) and sized; none = the whole history. */
  checkpoint?: ReplayCheckpoint;
}

/** The branch message a projected Pi message comes from, and its rank in that message's projection. */
export interface MessageOrigin {
  messageId: string;
  offset: number;
}

/** A summary found on the branch, and the branch index of the message its kept history starts in. */
export interface SummaryCheckpoint {
  summary: AppstrateTurnSummary;
  anchorIndex: number;
}

/** A checkpoint with the tokens its summary occupies as Pi sends it ({@link piSummaryTokens}). */
export interface ReplayCheckpoint extends SummaryCheckpoint {
  summaryTokens: number;
}

/** Tokens of a summary as Pi sends it: the user message its `convertToLlm` wraps the summary in. */
export function piSummaryTokens(
  pi: Pick<PiCodingAgentSdk, "convertToLlm" | "estimateTokens">,
  summary: string,
): number {
  return pi
    .convertToLlm([{ role: "compactionSummary", summary, tokensBefore: 0, timestamp: 0 }])
    .reduce((sum, message) => sum + pi.estimateTokens(message), 0);
}

interface StructuredPiTurn {
  history: Message[];
  /** The origin of each `history` message, index for index. */
  origins: MessageOrigin[];
  /** The summary the history starts after; absent = the whole branch is projected. */
  summary?: AppstrateTurnSummary;
  prompt: string;
  /** The images of the prompt message itself; the history ones ride their own messages. */
  promptImages: PiImageContent[];
  branchHeadId: string;
  sourceMessageCount: number;
  toolCallCount: number;
  toolResultCount: number;
  contextTokens: number;
}

interface SessionManagerLike {
  appendMessage(message: Message): string;
  appendCompaction(summary: string, firstKeptEntryId: string | null, tokensBefore: number): string;
  getEntry(id: string): { timestamp: string } | undefined;
  getSessionFile(): string | undefined;
}

interface SessionManagerFactory<T extends SessionManagerLike> {
  inMemory(cwd?: string): T;
}

type AssistantMessage = Extract<Message, { role: "assistant" }>;
type ToolResultMessage = Extract<Message, { role: "toolResult" }>;
type ToolResultContent = ToolResultMessage["content"];
type ToolCallArguments = Extract<
  AssistantMessage["content"][number],
  { type: "toolCall" }
>["arguments"];

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
    cost: { ...ZERO_MODEL_COST, total: 0 },
  };
}

/**
 * Pi stamps `Message.timestamp` with epoch milliseconds and compares assistant
 * timestamps against its own compaction entries. The canonical branch carries
 * no per-message time, so mint a monotonic sequence at projection time — the
 * same thing Pi does for the tool results it synthesizes. Ordering inside the
 * disposable session comes from the entry tree; {@link reconstructPiSession}
 * restamps what follows a summary, which Pi compares against.
 */
function projectionClock(): () => number {
  let next = Date.now();
  return () => next++;
}

// Tool inputs come from persisted (JSON-parsed) UI messages, so they are JSON.
function record(value: unknown): ToolCallArguments {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as ToolCallArguments;
  }
  return value === undefined ? {} : ({ value } as ToolCallArguments);
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
 * Convert one persisted tool output into Pi tool-result content.
 *
 * Replay stored text and receipts. Live image bytes belong to their originating
 * turn. Legacy or foreign non-text blocks get pointers so the JSON fallback
 * cannot turn binary data into model-visible text.
 *
 * The persisted relay mark preserves the original connect-offer scope.
 */
function toolResultContent(value: unknown, scope: OfferScope): ToolResultContent {
  if (value && typeof value === "object") {
    const content = (value as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const blocks = content.flatMap((part): ToolResultContent => {
        if (!part || typeof part !== "object") return [];
        if ((part as { type?: unknown }).type !== "text") return [];
        return [
          {
            type: "text",
            text: splitJsonText(String((part as { text?: unknown }).text ?? ""), scope).text,
          },
        ];
      });
      if (blocks.length > 0) return blocks;
      const pointers = content.flatMap((part): ToolResultContent => {
        if (!part || typeof part !== "object") return [];
        const type = String((part as { type?: unknown }).type ?? "unknown");
        const mime = (part as { mimeType?: unknown }).mimeType;
        return [{ type: "text", text: `[${type}${mime ? ` ${String(mime)}` : ""}]` }];
      });
      if (pointers.length > 0) return pointers;
    }
  }
  return [{ type: "text", text: json(scope(value).redacted) }];
}

function userMessage(
  message: UIMessage,
  nextTimestamp: () => number,
  images: readonly PiImageContent[] = [],
): Message | null {
  const text = message.parts.flatMap((part) =>
    part.type === "text" && part.text.length > 0
      ? [{ type: "text" as const, text: part.text }]
      : [],
  );
  if (text.length === 0) return null;
  const content = [...text, ...images];
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
    const content: AssistantMessage["content"] = [];
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
      const args = record(part.input);
      content.push({
        type: "toolCall",
        id: part.toolCallId,
        name: toolName,
        arguments: args,
      });
      toolCallCount += 1;

      let result: unknown;
      let isError: boolean;
      if (part.state === "output-available") {
        // The browser submits its branch, which can still contain a file read before an upgrade.
        const { uri } = args;
        result =
          typeof uri === "string" && uri.startsWith(FILE_URI_PREFIX)
            ? `[File content omitted on replay: ${uri}]`
            : part.output;
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
        content: toolResultContent(
          result,
          offerScopeOf(toolName, {
            arguments: part.input,
            relayed: (result as { relayed?: unknown } | null)?.relayed === true,
          }),
        ),
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

// The summary rides client-sent history (JSONB): narrow it before trusting it.
const turnSummarySchema = z.object({
  text: z.string().min(1),
  keptFrom: z.object({ messageId: z.string().min(1), offset: z.int().nonnegative() }),
  tokensBefore: z.number().nonnegative(),
});

/**
 * The Pi messages one branch message projects to, the range a `keptFrom.offset` ranks in. The model
 * only stamps the assistants' `api`/`provider`; it is the projection's own argument.
 */
function projectAnchor(message: UIMessage, model: PiHistoryModel): Message[] {
  if (message.role === "assistant") return assistantMessages(message, model, () => 0).messages;
  if (message.role !== "user") return [];
  const [converted] = messagesWithAttachmentsAsText([message]);
  const user = converted && userMessage(converted, () => 0);
  return user ? [user] : [];
}

/** The checkpoint a branch message's summary gives, or why it gives none. */
function checkpointAt(
  branch: readonly UIMessage[],
  carrier: number,
  summary: unknown,
  model: PiHistoryModel,
): { reason: string } | SummaryCheckpoint {
  const parsed = turnSummarySchema.safeParse(summary);
  if (!parsed.success) return { reason: "malformed summary metadata" };
  const { messageId, offset } = parsed.data.keptFrom;
  const anchorIndex = branch.findLastIndex(
    (message, index) => index <= carrier && message.id === messageId,
  );
  if (anchorIndex < 0) {
    return branch.some((message, index) => index > carrier && message.id === messageId)
      ? { reason: "its kept history starts after the turn that made it" }
      : { reason: "its kept history is not on the branch" };
  }
  const projected = projectAnchor(branch[anchorIndex]!, model);
  if (offset > 0 && offset >= projected.length) {
    return { reason: "its anchor offset is past the message's projection" };
  }
  // Pi never starts kept history on a tool result (`isCutPointMessage`, compaction.js): replayed
  // first, it would answer a call the request no longer carries.
  if (projected[offset]?.role === "toolResult") {
    return { reason: "its anchor offset lands on a tool result" };
  }
  return { summary: parsed.data, anchorIndex };
}

/**
 * The newest summary on the branch whose kept history starts on the branch, at or before the
 * turn that made it. A summary whose start is not there (the branch was edited under it) is
 * skipped for an older one; none = the whole history is projected.
 */
export function resolveSummaryCheckpoint(
  branch: readonly UIMessage[],
  model: PiHistoryModel,
): SummaryCheckpoint | undefined {
  for (let carrier = branch.length - 1; carrier >= 0; carrier -= 1) {
    const summary = turnMetadataFromMessage(branch[carrier])?.summary;
    if (summary === undefined) continue;
    const found = checkpointAt(branch, carrier, summary, model);
    if ("summary" in found) return found;
    logger.warn(`chat summary ignored: ${found.reason}`, { carrierId: branch[carrier]!.id });
  }
  return undefined;
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
 *
 * With a checkpoint, only what follows the summary's start is converted: Pi never sends
 * what the summary replaces.
 */
export function buildStructuredPiTurn(
  input: UIMessage[],
  model: PiHistoryModel,
  {
    estimateTokens,
    baseTokens,
    images,
    modelSeesImages = false,
    pdfReceipts,
    checkpoint,
  }: BuildStructuredPiTurnOptions,
): StructuredPiTurn {
  const sentImages: AttachmentImages = images ?? new Map();
  const messages = messagesWithAttachmentsAsText(input, {
    modelSeesImages,
    sent: sentImages,
    pdfReceipts,
  });
  const last = messages.at(-1);
  if (!last || last.role !== "user") {
    throw new Error("The active Pi chat branch must end with a user message.");
  }

  const start = checkpoint?.anchorIndex ?? 0;
  const nextTimestamp = projectionClock();
  const history: Message[] = [];
  const origins: MessageOrigin[] = [];
  let toolCallCount = 0;
  let toolResultCount = 0;
  for (let index = start; index < messages.length - 1; index += 1) {
    const message = messages[index]!;
    let converted: Message[] = [];
    if (message.role === "user") {
      const user = userMessage(message, nextTimestamp, [
        ...(sentImages.get(message.id)?.values() ?? []),
      ]);
      if (user) converted = [user];
    } else if (message.role === "assistant") {
      const assistant = assistantMessages(message, model, nextTimestamp);
      converted = assistant.messages;
      toolCallCount += assistant.toolCallCount;
      toolResultCount += assistant.toolResultCount;
    }
    const skip = index === start && checkpoint ? checkpoint.summary.keptFrom.offset : 0;
    converted.forEach((piMessage, offset) => {
      if (offset < skip) return;
      history.push(piMessage);
      origins.push({ messageId: message.id, offset });
    });
  }

  // Pi reads its compaction threshold off the usage carried by the newest
  // assistant message it can see, falling back to its own estimate only when
  // there is none. A projected history reporting zero would make an
  // arbitrarily long thread look empty to that check, so each assistant
  // carries the running estimate of everything up to it. The real usage of
  // this turn's own responses overwrites it as soon as it arrives.
  let contextTokens = baseTokens + (checkpoint?.summaryTokens ?? 0);
  for (const message of history) {
    contextTokens += estimateTokens(message);
    if (message.role === "assistant") message.usage = historyUsage(contextTokens);
  }

  return {
    history,
    origins,
    ...(checkpoint ? { summary: checkpoint.summary } : {}),
    prompt: uiMessageText(last.parts),
    promptImages: [...(sentImages.get(last.id)?.values() ?? [])],
    branchHeadId: last.id,
    sourceMessageCount: messages.length - 1 - start,
    toolCallCount,
    toolResultCount,
    contextTokens,
  };
}

/**
 * Reconstruct a disposable Pi session without creating a second durable history, and map each
 * entry it appended to the branch message it came from.
 *
 * A summary goes right after the first kept message, so every later assistant follows it and Pi
 * reads their estimated usage. Pi ignores an assistant stamped at or before its summary entry,
 * which it stamps with the current time: what follows is restamped past that.
 */
export function reconstructPiSession<T extends SessionManagerLike>(
  SessionManager: SessionManagerFactory<T>,
  turn: Pick<StructuredPiTurn, "history" | "origins" | "summary">,
): { session: T; origins: Map<string, MessageOrigin> } {
  const session = SessionManager.inMemory(PI_CHAT_CWD);
  const origins = new Map<string, MessageOrigin>();
  const append = (message: Message, index: number) => {
    origins.set(session.appendMessage(message), turn.origins[index]!);
  };
  if (!turn.summary) {
    turn.history.forEach(append);
    return { session, origins };
  }
  const [first, ...rest] = turn.history;
  const firstKeptId = first ? session.appendMessage(first) : undefined;
  if (firstKeptId) origins.set(firstKeptId, turn.origins[0]!);
  const compactionId = session.appendCompaction(
    turn.summary.text,
    firstKeptId ?? null,
    turn.summary.tokensBefore,
  );
  const summarizedAt = Date.parse(session.getEntry(compactionId)!.timestamp);
  // One stamp for all of them: later ones would run ahead of a summary Pi makes during the turn.
  rest.forEach((message, index) => append({ ...message, timestamp: summarizedAt + 1 }, index + 1));
  return { session, origins };
}
