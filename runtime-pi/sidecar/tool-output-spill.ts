// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * The one inline-vs-spill decision for text tool output, shared by every
 * path that hands text to the agent: `{ns}__api_call` / platform tools
 * (`responseToToolResult` in `./mcp.ts`) and third-party MCP tool results
 * multiplexed by `McpHost` (`./mcp-host.ts`). Both paths draw on the same
 * run-scoped {@link TokenBudget} and {@link BlobStore}, so a call on one
 * path tightens the inline threshold of the other.
 */

import { getErrorMessage } from "@appstrate/core/errors";
import type { CallToolResult } from "@appstrate/mcp-transport";
import type { BlobStore } from "./blob-store.ts";
import { logger } from "./logger.ts";
import type { TokenBudget } from "./token-budget.ts";

/** Run-scoped deps of the spill decision. */
export interface ToolOutputBudgetDeps {
  tokenBudget: TokenBudget;
  /** Absent: text that should spill is cut to the inline cap instead. */
  blobStore?: BlobStore;
}

// ≈ 900 chars: well above the agent-side workspace pointer (~200 chars) that would replace it.
const ALWAYS_INLINE_TOKENS = 256;

interface ResourceLinkBlock {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType?: string;
}

interface TextContent {
  type: "text";
  text: string;
}

/**
 * Reserve `text` inline, or stash it in the blob store and return the
 * `resource_link` that replaces it. `null` means "deliver `text` as is"
 * (its tokens are recorded). When the budget says spill but the blob
 * store is absent or refuses the bytes, the text is cut to the inline cap
 * and returned as a replacement `text` block: delivering it whole is how
 * an oversized output overflows the model request.
 */
export function spillTextIfOverBudget(
  text: string,
  deps: ToolOutputBudgetDeps,
  meta: { mimeType: string; source?: string },
): ResourceLinkBlock | TextContent | null {
  const { tokenBudget, blobStore } = deps;
  const estimatedTokens = tokenBudget.estimate(text);
  // Atomic decide + record: an interleaved concurrent call cannot observe a stale `consumed`.
  const decision = tokenBudget.tryReserve(estimatedTokens);
  logger.debug("token-budget decision", {
    decision: decision.decision,
    reason: decision.reason,
    estimatedTokens,
    consumedTokens: decision.consumedTokens,
  });
  if (decision.decision === "inline") return null;
  // A spent run budget must not turn "Clicked" into a pointer longer than itself.
  if (estimatedTokens <= Math.min(ALWAYS_INLINE_TOKENS, tokenBudget.inlineCapTokens)) {
    if (estimatedTokens > 0) tokenBudget.record(estimatedTokens);
    return null;
  }

  if (!blobStore) {
    const cut = fitToInlineCap(text, tokenBudget, "spill unavailable: no blob store");
    logger.warn("token-budget: no blob store configured, cut to inline cap", {
      source: meta.source,
      estimatedTokens,
      consumedTokens: tokenBudget.consumedTokens(),
    });
    return { type: "text", text: cut };
  }
  let record;
  try {
    record = blobStore.put(new TextEncoder().encode(text), {
      mimeType: meta.mimeType,
      ...(meta.source !== undefined ? { source: meta.source } : {}),
    });
  } catch (err) {
    const cut = fitToInlineCap(text, tokenBudget, "spill unavailable: blob store full");
    logger.warn("token-budget: blob store full, cut to inline cap", {
      source: meta.source,
      estimatedTokens,
      consumedTokens: tokenBudget.consumedTokens(),
      error: getErrorMessage(err),
    });
    return { type: "text", text: cut };
  }
  logger.info("token-budget: spilled to blob store", {
    source: meta.source,
    estimatedTokens,
    consumedTokens: tokenBudget.consumedTokens(),
    uri: record.uri,
  });
  return {
    type: "resource_link",
    uri: record.uri,
    name: meta.source ?? "blob",
    mimeType: record.mimeType,
  };
}

/**
 * `text` when it fits the inline cap, else its head and tail (together
 * sized to the cap) around a marker naming how much was cut and why.
 * Records the tokens of what it returns: that is what reaches the model.
 */
function fitToInlineCap(text: string, tokenBudget: TokenBudget, reason: string): string {
  const estimated = tokenBudget.estimate(text);
  let delivered = text;
  if (estimated > tokenBudget.inlineCapTokens) {
    // The share of characters that fits under the cap, whatever the estimator.
    const half = Math.floor((text.length * tokenBudget.inlineCapTokens) / estimated / 2);
    const head = text.slice(0, codePointBoundary(text, half));
    const tail = text.slice(codePointBoundary(text, text.length - half));
    const removed = text.length - head.length - tail.length;
    delivered = `${head}\n\n[… output cut: ${removed} characters removed (${reason}) …]\n\n${tail}`;
  }
  const deliveredTokens = tokenBudget.estimate(delivered);
  if (deliveredTokens > 0) tokenBudget.record(deliveredTokens);
  return delivered;
}

/** Moves `index` off the low half of a surrogate pair, so no cut splits a code point. */
function codePointBoundary(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
}

type ContentBlock = CallToolResult["content"][number];
type TextBlock = Extract<ContentBlock, { type: "text" }>;

const isTextBlock = (block: ContentBlock): block is TextBlock => block.type === "text";

/**
 * Budget a third-party MCP tool result as one unit: all its `text` blocks
 * together, since a server may return thousands of small ones.
 *
 * - Fits → returned untouched.
 * - Over budget → the joined text goes to the blob store and ONE
 *   `resource_link` takes the place of the first text block (one cut
 *   `text` block when the store cannot take it); every other block keeps
 *   its position. The agent runtime materialises the link as a workspace
 *   file.
 * - `isError` → never spilled (the model must read its failure); text over
 *   the inline cap keeps a head and a tail around an explicit marker.
 *
 * `structuredContent` is left as is: the agent runtime keeps it out of the
 * model request, and a tool with an `outputSchema` must still return it.
 */
export function budgetMcpToolResult(
  result: CallToolResult,
  deps: ToolOutputBudgetDeps,
  source: string,
): CallToolResult {
  const texts = result.content.filter(isTextBlock);
  if (texts.length === 0) return result;
  const joined = texts.length === 1 ? texts[0]!.text : texts.map((b) => b.text).join("\n");
  if (joined.length === 0) return result;

  if (result.isError) return truncateErrorResult(result, joined, deps.tokenBudget);

  const replacement = spillTextIfOverBudget(joined, deps, {
    // Several JSON blocks joined are NDJSON at best, never one JSON document.
    mimeType: texts.length === 1 ? textMimeType(joined) : "text/plain",
    source,
  });
  return replacement ? replaceTextBlocks(result, replacement) : result;
}

/** Swap every text block for `replacement`, placed where the first one was. */
function replaceTextBlocks(result: CallToolResult, replacement: ContentBlock): CallToolResult {
  const content: ContentBlock[] = [];
  let replaced = false;
  for (const block of result.content) {
    if (!isTextBlock(block)) content.push(block);
    else if (!replaced) {
      content.push(replacement);
      replaced = true;
    }
  }
  return { ...result, content };
}

/**
 * Bracket shape only, never `JSON.parse` nor `trim()`: both would copy or
 * expand a multi-megabyte body inside the sidecar's 256 MiB cgroup just to
 * pick a file extension.
 */
function textMimeType(text: string): string {
  let start = 0;
  let end = text.length - 1;
  while (start <= end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end]!)) end--;
  const first = text[start];
  const last = text[end];
  return start < end && ((first === "{" && last === "}") || (first === "[" && last === "]"))
    ? "application/json"
    : "text/plain";
}

function truncateErrorResult(
  result: CallToolResult,
  joined: string,
  tokenBudget: TokenBudget,
): CallToolResult {
  const delivered = fitToInlineCap(joined, tokenBudget, "error output over the inline cap");
  return delivered === joined
    ? result
    : replaceTextBlocks(result, { type: "text", text: delivered });
}
