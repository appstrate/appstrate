// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Exit for runner-registered Pi tools. Pi flags a call failed on a throw or on
 * a returned `isError: true` (agent-loop `executePreparedToolCall`); this
 * result type carries no `isError`, so an error result throws its text blocks
 * as the message, which Pi rebuilds into the tool result — image blocks and
 * `details` (e.g. an MCP `structuredContent` error envelope) do not survive
 * into the run log.
 */

export type PiToolContent =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface PiToolResult {
  content: PiToolContent[];
  details: unknown;
}

interface ToolResultData {
  content: PiToolContent[];
  details?: unknown;
  isError?: boolean;
}

export function piToolResultOrThrow(result: ToolResultData): PiToolResult {
  if (result.isError === true) {
    const text = result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
    throw new Error(text || "Tool call failed");
  }
  return { content: result.content, details: result.details };
}
