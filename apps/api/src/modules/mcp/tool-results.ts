// SPDX-License-Identifier: Apache-2.0

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RunAndWaitArgumentCode } from "@appstrate/core/run-and-wait-client";

/**
 * A tool's JSON answer: `structuredContent` plus the same JSON as text (MCP 2025-06-18);
 * an error carries the text only.
 */
export function jsonResult(payload: Record<string, unknown>, isError = false): CallToolResult {
  const content = [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }];
  return isError ? { content, isError } : { content, structuredContent: payload, isError };
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

/** Why a tool call was refused. Stable machine codes. */
type RefusalCode =
  | RunAndWaitArgumentCode
  | "unknown_operation"
  | "unknown_space"
  | "space_mismatch"
  | "not_granted"
  | "not_found"
  | "too_large";

/**
 * Every refused tool call, from every tool (MCP 2025-11-25, SEP-1303: input
 * validation is a tool result, not a JSON-RPC error). `isError: true`, JSON
 * as text only. `-32602` remains only for an unknown tool name (transport).
 */
export interface Refusal {
  code: RefusalCode;
  /** Prose. A space is named ``Name (`spc_…`, role r)`` (describeSpace). */
  error: string;
  /** The arguments at fault, as paths: `space_id`, `path_params`, `query.x`, `headers.X-Y`. */
  arguments?: readonly string[];
  /** What those arguments accept: declared names, reachable space ids, an enum. */
  accepted?: readonly string[];
  /** Org-wide: the space the call was refused in (same shape as successes). */
  space?: { id: string; name: string };
  /** Org-wide `not_granted`: reachable space IDS granting it; absent when all do. */
  granted_in?: readonly string[];
  required_permissions?: readonly string[];
  ceiling_permissions?: readonly string[];
  /** Next step (`not_granted`: NO_FALLBACK_HINT / report it). */
  hint?: string;
}

export function refusalResult(refusal: Refusal): CallToolResult {
  return jsonResult({ ...refusal }, true);
}

/**
 * Thrown by nested helpers (the package and file readers); the tool handler or
 * resource provider that called them maps it to its own answer.
 */
export class ToolRefusal extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.error);
    this.name = "ToolRefusal";
  }
}
