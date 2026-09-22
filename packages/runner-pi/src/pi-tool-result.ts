// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * The one exit every Appstrate-registered Pi tool returns through.
 *
 * Pi has a single way for a tool to report failure: throw from `execute`.
 * A returned value is always a success — `AgentToolResult` has no error
 * field, and an `isError` property on the returned object is ignored
 * (pi-coding-agent `docs/extensions.md`, "Signaling errors"). The thrown
 * message becomes the tool result's text, flagged `isError: true` on
 * `tool_execution_end`, in the run log (`Tool error`) and in the provider's
 * tool-result block the model reads.
 *
 * Tools here produce MCP/AFPS-style results that carry `isError` as data, so
 * {@link toPiToolResult} is where that data becomes Pi's contract: a failure
 * throws with the text blocks as its message, a success returns
 * `{ content, details }`. An error result's image blocks and `details` do not
 * survive the throw — Pi rebuilds the result from the message alone.
 */

export type PiToolContent =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface PiToolResult {
  content: PiToolContent[];
  details: unknown;
}

/** A tool result expressed as data — `isError` marks a tool-level failure. */
interface ToolResultData {
  content: PiToolContent[];
  details?: unknown;
  isError?: boolean;
}

/**
 * Hand a tool result to Pi: return it on success, throw it on failure so Pi
 * records a tool error. Never returns an error result.
 */
export function toPiToolResult(result: ToolResultData): PiToolResult {
  if (result.isError === true) {
    const text = result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
    throw new Error(text || "Tool call failed");
  }
  return { content: result.content, details: result.details };
}
