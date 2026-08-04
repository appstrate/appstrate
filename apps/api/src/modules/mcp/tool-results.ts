// SPDX-License-Identifier: Apache-2.0

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function textResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
