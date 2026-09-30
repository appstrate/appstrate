// SPDX-License-Identifier: Apache-2.0

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function textResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Ceiling on inlining a NON-textual file's RAW bytes as base64 in a tool or
 * `resources/read` result. Base64 inflates 4/3, so a 700 KiB raw cap keeps the
 * encoded payload (~933 KiB) under the ~1 MB practical MCP response limit. Above
 * it (either kind) the read returns metadata only.
 */
export const RESOURCE_BLOB_MAX_BYTES = 700 * 1024;
