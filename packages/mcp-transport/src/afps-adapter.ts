// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS Tool → MCP adapter.
 *
 * AFPS `Tool` (from `@afps-spec/types`) and MCP's `Tool` + `CallToolResult`
 * are deliberately almost-aligned: the AFPS spec docstring states that
 * `ToolResult.content` "mirrors the MCP/Anthropic tool-result format". The
 * remaining gaps are mechanical:
 *
 * | AFPS                              | MCP                              |
 * |-----------------------------------|----------------------------------|
 * | `name` / `description`            | same                             |
 * | `parameters` (JSON Schema)        | `inputSchema` (JSON Schema)      |
 * | `execute(args, ctx)`              | `handler(args)` (+ extra)        |
 * | `ToolResult { content, isError }` | `CallToolResult` (same shape)    |
 * | `ToolContext { emit, signal, … }` | not part of the wire             |
 *
 * The runtime side (caller of the LLM) supplies the AFPS `ToolContext` —
 * it carries cross-cutting concerns (event emission, workspace path,
 * cancellation signal, run id) that the wire format does not surface.
 * `fromAfpsTool()` binds a context provider so each MCP `tools/call`
 * dispatches with a fresh `ToolContext` (signal threaded through from the
 * SDK's `RequestHandlerExtra`).
 *
 * Why this lives here and not in `@appstrate/afps-runtime`: the adapter
 * pulls in the MCP SDK; afps-runtime ships with zero MCP knowledge by
 * design (it is the framework-agnostic spec runtime). Keeping the
 * dependency direction `mcp-transport → afps-runtime types` preserves
 * that.
 */

import type { Tool as AfpsTool, ToolContext, ToolResult } from "@afps-spec/types";
import type { AppstrateToolDefinition, AppstrateToolHandler } from "./index.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Builds the per-invocation AFPS `ToolContext` for an MCP `tools/call`.
 *
 * The MCP SDK supplies the request `signal` through `RequestHandlerExtra`
 * — we thread it through verbatim so AFPS tools that respect cancellation
 * (per the AFPS §6.2 contract) keep working unchanged. The remaining
 * fields (`runId`, `workspace`, `emit`, `toolCallId`) are runtime-bound
 * once at registration; per-call invocations may override `toolCallId`
 * via `RequestHandlerExtra.requestId` if the caller wishes.
 */
export type AfpsContextProvider = (input: {
  signal: AbortSignal;
  /** Stable across the run; supplied by the wiring layer. */
  runId: string;
  /** Run scratch workspace; supplied by the wiring layer. */
  workspace: string;
  /** Fan-out event emitter (same instance shared with the run sink). */
  emit: ToolContext["emit"];
  /** MCP request id, stringified — used as `toolCallId`. */
  requestId: string | number;
}) => ToolContext;

/**
 * Defaults — the trivial provider runtimes can use when they don't need
 * to thread a richer context. `emit` becomes a no-op (events stay local
 * to the AFPS tool), `workspace` defaults to the OS temp dir.
 */
export interface FromAfpsToolOptions {
  /** Stable run id surfaced to AFPS tools. */
  runId: string;
  /** Scratch workspace path. */
  workspace: string;
  /** Optional event emitter; defaults to a no-op. */
  emit?: ToolContext["emit"];
  /**
   * Override the default context provider. Use when you need to inject
   * additional fields beyond the standard `ToolContext` surface.
   */
  contextProvider?: AfpsContextProvider;
}

/**
 * Convert an AFPS `Tool` to an `AppstrateToolDefinition` ready to be
 * registered via {@link createMcpServer} or {@link createInProcessPair}.
 *
 * The wrapped handler:
 *
 * 1. Parses the SDK's `RequestHandlerExtra` to recover the request signal
 *    (cancellation) and id (`toolCallId`).
 * 2. Builds an AFPS `ToolContext` via the provider.
 * 3. Calls `tool.execute(args, ctx)` and translates the AFPS `ToolResult`
 *    into the SDK's `CallToolResult` (the shapes are byte-compatible —
 *    the cast is purely a TypeScript narrowing exercise).
 *
 * Throws from `execute()` propagate as JSON-RPC `InternalError` (the SDK
 * auto-wraps them); the AFPS contract distinguishes "business failure"
 * (`isError: true` in the result) from "runtime fault" (throw), and that
 * distinction is preserved on the MCP side.
 */
export function fromAfpsTool(
  tool: AfpsTool,
  options: FromAfpsToolOptions,
): AppstrateToolDefinition {
  const provider: AfpsContextProvider =
    options.contextProvider ??
    (({ signal, runId, workspace, emit, requestId }) => ({
      signal,
      runId,
      workspace,
      emit,
      toolCallId: String(requestId),
    }));
  const noopEmit: ToolContext["emit"] = () => {};
  const emit = options.emit ?? noopEmit;

  const handler: AppstrateToolHandler = async (args, extra) => {
    const ctx = provider({
      // The SDK guarantees an AbortSignal on every request handler.
      signal: extra?.signal ?? new AbortController().signal,
      runId: options.runId,
      workspace: options.workspace,
      emit,
      requestId: extra?.requestId ?? 0,
    });
    const result = await tool.execute(args, ctx);
    return afpsResultToMcp(result);
  };

  return {
    descriptor: {
      name: tool.name,
      description: tool.description,
      // AFPS `parameters` is `Record<string, unknown>` — same shape MCP
      // expects for `inputSchema`. We assert here rather than deep-clone
      // because both sides treat the value as an opaque JSON Schema doc.
      inputSchema: tool.parameters as AppstrateToolDefinition["descriptor"]["inputSchema"],
    },
    handler,
  };
}

/**
 * Translate an AFPS `ToolResult` to an MCP `CallToolResult`. Both shapes
 * use the same content discriminants (`text` / `image` / `resource`) and
 * the same optional `isError` flag, so the conversion is identity modulo
 * a TypeScript widening — the function exists so type drift between the
 * two libraries surfaces as a compile error here, not at every call site.
 */
function afpsResultToMcp(result: ToolResult): CallToolResult {
  // AFPS `{ type: "resource", uri, mimeType? }` is a URI *reference* —
  // no inline content. The MCP spec (2025-06-18+) reserves
  // `EmbeddedResource` for inline content (`text` or `blob` required)
  // and introduces `ResourceLink` (`type: "resource_link"`) for the
  // reference case. Map AFPS resources to ResourceLink so SDK clients
  // get a spec-compliant content block.
  const content: CallToolResult["content"] = result.content.map((block) => {
    if (block.type === "resource") {
      return {
        type: "resource_link" as const,
        // ResourceLink requires a `name`. AFPS resources carry no
        // human-readable label, so derive a sensible default from the
        // URI's basename (e.g. `workspace:///out/report.pdf` → `report.pdf`).
        // Callers needing richer labels can wrap fromAfpsTool in their
        // own conversion layer.
        name: deriveResourceName(block.uri),
        uri: block.uri,
        ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}),
      };
    }
    return block;
  });
  return {
    content,
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  };
}

/**
 * Extract a display-name for a `resource_link` from its URI.
 *
 * Falls back to the full URI when a basename cannot be cleanly extracted
 * — empty paths, opaque schemes (e.g. `urn:foo:bar`), or query-only URIs.
 * Never throws; never returns an empty string.
 */
function deriveResourceName(uri: string): string {
  try {
    const parsed = new URL(uri);
    // Strip query/fragment, then the trailing slash so a path like
    // `s3://bucket/key/` resolves to `key` rather than the empty string.
    const path = parsed.pathname.replace(/\/+$/, "");
    if (path) {
      const basename = path.slice(path.lastIndexOf("/") + 1);
      if (basename) return decodeURIComponent(basename);
    }
    if (parsed.hostname) return parsed.hostname;
  } catch {
    // Opaque URI (no scheme separator, or malformed). Fall through.
  }
  return uri;
}
