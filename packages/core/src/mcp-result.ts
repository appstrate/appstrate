// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

/** Successful JSON results of the platform integration's two read tools. */
export const recallMemoryOutputSchema = z.object({
  memories: z.array(
    z.object({
      id: z.int(),
      content: z.unknown(),
      createdAt: z.string(),
      actor_type: z.enum(["user", "end_user", "shared"]),
      actor_id: z.string().nullable(),
    }),
  ),
});
export const runHistoryOutputSchema = z.object({
  object: z.literal("list"),
  data: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      date: z.string().nullable(),
      duration: z.number().nullable(),
      checkpoint: z.unknown().optional(),
      result: z.unknown().optional(),
    }),
  ),
  hasMore: z.boolean(),
});

/**
 * Reading the payload out of an MCP tool result. A result reaches a UI as a raw
 * `CallToolResult` `{ content: [{ type: "text", text }] }`, a bare content
 * array, or a JSON string; {@link unwrapMcpResult} peels those layers down to
 * the payload so no consumer has to know which shape arrived.
 */

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

/**
 * Peel the runtime/bridge envelopes off a tool result, returning the inner
 * payload (parsed when it arrives as a JSON string). Depth-bounded so a
 * pathological structure can't loop.
 *
 * A content array may carry text parts that are NOT part of the payload: the Pi
 * engine appends a model-facing `[turn budget] …` line to every tool result, so
 * the payload is no longer the only text part and the concatenation
 * `{"id":"run_…"}[turn budget] …` is not JSON. Hence the rule for an array: the
 * first text part that parses on its own wins — producers put the payload in
 * one block, anything after it is prose. When no part parses, the joined text
 * is returned, so a plain-text result still reads verbatim. Without this the
 * payload reads as a string, and every consumer reading a record out of it (run
 * id/status, error shapes) silently degrades — a failed call would read as a success.
 */
export function unwrapMcpResult(value: unknown, depth = 0): unknown {
  if (depth > 8 || value == null) return value;

  if (typeof value === "string") {
    const s = value.trim();
    if (s[0] === "{" || s[0] === "[") {
      try {
        return unwrapMcpResult(JSON.parse(s), depth + 1);
      } catch {
        return value;
      }
    }
    return value;
  }

  if (Array.isArray(value)) {
    // MCP content array of text parts → the first part that is a payload on its
    // own, else the joined text (no payload here, just prose).
    const texts = value.filter(isTextPart).map((p) => p.text);
    if (texts.length > 0) {
      for (const text of texts) {
        const part = unwrapMcpResult(text, depth + 1);
        if (typeof part === "object" && part !== null) return part;
      }
      return texts.join("");
    }
    if (value.length === 1) return unwrapMcpResult(value[0], depth + 1);
    return value;
  }

  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (Array.isArray(o.content)) return unwrapMcpResult(o.content, depth + 1);
    if (o.type === "text" && typeof o.text === "string") return unwrapMcpResult(o.text, depth + 1);
    return o;
  }

  return value;
}

/** Project an MCP result before model consumption or spill. A structured mirror cannot be
 * separated by audience when one of the content blocks is private. */
export function assistantVisibleMcpResult<
  T extends {
    content: Array<{ type: string; annotations?: { audience?: readonly string[] } }>;
    structuredContent?: unknown;
  },
>(result: T) {
  const privateBlock = (block: T["content"][number]) =>
    block.annotations?.audience !== undefined && !block.annotations.audience.includes("assistant");
  if (!result.content.some(privateBlock)) return result;
  const projected = {
    ...result,
    content: result.content.map((block) =>
      privateBlock(block)
        ? {
            type: "text" as const,
            text: "Tool content omitted from model input by its audience annotation.",
          }
        : block,
    ),
  };
  delete projected.structuredContent;
  return projected;
}
