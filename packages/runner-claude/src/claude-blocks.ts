// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Shared parsing of the Claude Agent SDK `tool_result` content blocks.
 *
 * Both Claude mappers read the `user` message's `content[]` for tool results:
 * the agent runner ({@link import("./sdk-event-mapper.ts")}) turns them into
 * `appstrate.progress` RunEvents, and the chat ui-stream mapper
 * (`@appstrate/module-claude-code`) turns them into UI `tool-output-*` chunks.
 * The block discrimination + field names (`tool_result` / `tool_use_id` /
 * `is_error` / `content`) are the one piece both genuinely share — so they live
 * here, and a new SDK field is added in ONE place. The two mappers only differ
 * in OUTPUT shape, which stays in each.
 *
 * (Text and `tool_use` blocks are NOT shared: the agent path reads them off the
 * complete `assistant` message, while the chat path streams them as
 * `stream_event` deltas — different wire shapes, no overlap.)
 */

/** A neutral view of one Anthropic `tool_result` block. */
export interface ClaudeToolResult {
  /** The originating tool call's id (absent on a malformed block). */
  toolUseId?: string;
  /** Whether the tool reported an error. */
  isError: boolean;
  /** Raw block content (string | block[] | …) — each consumer renders it. */
  content: unknown;
}

/**
 * Extract the `tool_result` blocks from an SDK `user` message's `content`.
 * Non-array content and non-tool_result blocks are skipped; `toolUseId` is
 * carried through when present so each caller can decide whether to require it.
 */
export function parseToolResultBlocks(content: unknown): ClaudeToolResult[] {
  if (!Array.isArray(content)) return [];
  const out: ClaudeToolResult[] = [];
  for (const raw of content) {
    const b = raw as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
    if (b?.type !== "tool_result") continue;
    out.push({
      ...(typeof b.tool_use_id === "string" ? { toolUseId: b.tool_use_id } : {}),
      isError: b.is_error === true,
      content: b.content,
    });
  }
  return out;
}
