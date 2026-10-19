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
  /** Absent: text that should spill is forced inline and recorded against the budget. */
  blobStore?: BlobStore;
}

interface ResourceLinkBlock {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType?: string;
}

/**
 * Reserve `text` inline, or stash it in the blob store and return the
 * `resource_link` that replaces it. `null` means "deliver inline": the
 * tokens are already recorded, including on the two forced-inline
 * fallbacks (no blob store, blob store refused the bytes).
 */
export function spillTextIfOverBudget(
  text: string,
  deps: ToolOutputBudgetDeps,
  meta: { mimeType: string; source?: string },
): ResourceLinkBlock | null {
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

  if (!blobStore) {
    tokenBudget.record(estimatedTokens);
    logger.warn("token-budget: no blob store configured, forced inline", {
      source: meta.source,
      estimatedTokens,
      consumedTokens: tokenBudget.consumedTokens(),
    });
    return null;
  }
  let record;
  try {
    record = blobStore.put(new TextEncoder().encode(text), {
      mimeType: meta.mimeType,
      ...(meta.source !== undefined ? { source: meta.source } : {}),
    });
  } catch (err) {
    tokenBudget.record(estimatedTokens);
    logger.warn("token-budget: blob store full, forced inline", {
      source: meta.source,
      estimatedTokens,
      consumedTokens: tokenBudget.consumedTokens(),
      error: getErrorMessage(err),
    });
    return null;
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

type ContentBlock = CallToolResult["content"][number];
type TextBlock = Extract<ContentBlock, { type: "text" }>;

const isTextBlock = (block: ContentBlock): block is TextBlock => block.type === "text";

/**
 * Budget a third-party MCP tool result as one unit: all its `text` blocks
 * together, since a server may return thousands of small ones.
 *
 * - Fits → returned untouched.
 * - Over budget → the joined text goes to the blob store and ONE
 *   `resource_link` takes the place of the first text block; every other
 *   block keeps its position. The agent runtime materialises the link as
 *   a workspace file.
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

  const link = spillTextIfOverBudget(joined, deps, { mimeType: textMimeType(joined), source });
  return link ? replaceTextBlocks(result, link) : result;
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
 * Bracket shape only, never `JSON.parse`: parsing a multi-megabyte body
 * would build its whole object graph inside the sidecar's 256 MiB cgroup
 * just to pick a file extension.
 */
function textMimeType(text: string): string {
  const trimmed = text.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === "{" && last === "}") || (first === "[" && last === "]")
    ? "application/json"
    : "text/plain";
}

function truncateErrorResult(
  result: CallToolResult,
  joined: string,
  tokenBudget: TokenBudget,
): CallToolResult {
  const estimated = tokenBudget.estimate(joined);
  if (estimated <= tokenBudget.inlineCapTokens) {
    tokenBudget.record(estimated);
    return result;
  }
  // The share of characters that fits under the cap, whatever the estimator.
  const half = Math.floor((joined.length * tokenBudget.inlineCapTokens) / estimated / 2);
  const head = joined.slice(0, codePointBoundary(joined, half));
  const tail = joined.slice(codePointBoundary(joined, joined.length - half));
  const removed = joined.length - head.length - tail.length;
  const text = `${head}\n\n[… ${removed} characters of this error output removed …]\n\n${tail}`;
  tokenBudget.record(tokenBudget.estimate(text));
  return replaceTextBlocks(result, { type: "text", text });
}

/** Moves `index` off the low half of a surrogate pair, so no cut splits a code point. */
function codePointBoundary(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
}
