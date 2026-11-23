// SPDX-License-Identifier: Apache-2.0

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RunAndWaitArgumentCode } from "@appstrate/core/run-and-wait-client";
import { internalDispatchHeader } from "../../lib/internal-dispatch.ts";

/**
 * A tool's JSON answer: `structuredContent` plus the same JSON as text (MCP 2025-06-18);
 * errors preserve their published text shape and distinguish route and tool refusals in structuredContent.
 */
export function jsonResult(payload: Record<string, unknown>, isError = false): CallToolResult {
  const content = [{ type: "text" as const, text: JSON.stringify(payload) }];
  return {
    content,
    isError,
    structuredContent: isError
      ? { ...payload, kind: typeof payload.status === "number" ? "route_refusal" : "tool_refusal" }
      : payload,
  };
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The headers of an in-process dispatch: the caller's auth context and the trusted re-entry
 * marker (`lib/internal-dispatch.ts`), written onto `into`.
 */
export function dispatchHeaders(authHeaders: Headers, into = new Headers()): Headers {
  authHeaders.forEach((value, name) => into.set(name, value));
  into.set(...internalDispatchHeader());
  return into;
}

/** `Headers.set`, answering `false` where it would throw on an invalid name/value. */
export function trySetHeader(headers: Headers, name: string, value: string): boolean {
  try {
    headers.set(name, value);
    return true;
  } catch {
    return false;
  }
}

/** Why a tool call was refused. Stable machine codes. */
type RefusalCode =
  | RunAndWaitArgumentCode
  | "unknown_operation"
  | "unknown_tool"
  | "ambiguous_tool"
  | "unknown_space"
  | "space_mismatch"
  | "not_granted"
  | "credential_proxy_closed"
  | "not_found"
  | "too_large";

/**
 * Every refused tool call, from every tool (MCP 2025-11-25, SEP-1303: input
 * validation is a tool result, not a JSON-RPC error). `isError: true`, the original JSON
 * text and a typed structured refusal. `-32602` remains only for an unknown tool name (transport).
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
  /**
   * Org-wide `not_granted` and `credential_proxy_closed`: reachable space IDS granting it;
   * absent when all do.
   */
  granted_in?: readonly string[];
  required_permissions?: readonly string[];
  ceiling_permissions?: readonly string[];
  /** Next step (`not_granted`: NO_FALLBACK_HINT / report it). */
  hint?: string;
}

/** A route's refusal, as `invoke_operation` relays one: its status and problem body. */
export interface RouteRefusal {
  status: number;
  body: unknown;
}

/** A refusal result: a tool's own {@link Refusal}, or a route's relayed as is. */
export function refusalResult(refusal: Refusal | RouteRefusal): CallToolResult {
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
