// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Generic Pi-extension factory for runtime-injected tools that forward
 * verbatim to the sidecar over MCP `tools/call`.
 *
 * This is the symmetric counterpart to `buildProviderCallExtensionFactory`:
 * `provider_call` is bundle-driven (one tool, dispatches by
 * `providerId`), and the runtime-injected tools (`run_history`,
 * `recall_memory`, …) are runtime-driven (one Pi-tool registration per
 * descriptor in {@link RUNTIME_INJECTED_TOOLS}). Hosting both factories
 * in `@appstrate/runner-pi` keeps the runtime container's
 * `mcp/direct.ts` orchestration-only — no per-tool boilerplate.
 *
 * Why a single factory: each tool's wiring is a four-step recipe —
 *   1. emit `<tool>.called` with `toolCallId`/`runId`,
 *   2. forward verbatim via `mcp.callTool`,
 *   3. emit `<tool>.completed` with duration + isError,
 *   4. adapt the MCP `CallToolResult` to Pi's `AgentToolResult` shape.
 *
 * Re-encoding that recipe per tool is pure copy-paste. {@link
 * buildRuntimeToolFactories} produces one extension factory per
 * descriptor in {@link RUNTIME_INJECTED_TOOLS}, so adding a new
 * runtime-injected tool only requires extending that array — no new
 * code in either the runner-pi or runtime-pi tree.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { AppstrateMcpClient, CallToolResult } from "@appstrate/mcp-transport";
import { RUNTIME_INJECTED_TOOLS, type RuntimeInjectedTool } from "./index.ts";

type PiToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface PiToolResult {
  content: PiToolContent[];
  details: undefined;
}

/**
 * Adapt an MCP `CallToolResult` into Pi's `AgentToolResult.content`
 * shape. Pi accepts only `text` and `image` blocks; MCP can also return
 * `resource_link` and inline `resource` blocks, which we render as
 * text pointers (`[resource <uri>]`) so the LLM still sees the URI and
 * can fetch the resource via `resources/read` if it cares.
 */
function callToolResultToPi(result: CallToolResult): PiToolResult {
  const content: PiToolContent[] = result.content.map((c) => {
    if (c.type === "text") return { type: "text", text: c.text };
    if (c.type === "image") return { type: "image", data: c.data, mimeType: c.mimeType };
    if (c.type === "resource_link") {
      return {
        type: "text",
        text: `[resource ${c.uri}${c.name ? ` (${c.name})` : ""}]`,
      };
    }
    if (c.type === "resource") {
      const inner = c.resource;
      return {
        type: "text",
        text: `[resource ${inner.uri}${"text" in inner && inner.text ? `\n${inner.text}` : ""}]`,
      };
    }
    return {
      type: "text",
      text: `[unknown content type: ${(c as { type: string }).type}]`,
    };
  });
  return { content, details: undefined };
}

/**
 * Event emitter signature shared with `provider-bridge.ts`. Generic
 * shape so callers can route events into any sink (CloudEvents,
 * console, in-memory test recorder, …).
 */
export type RuntimeToolEventEmitter = (event: { type: string; [k: string]: unknown }) => void;

export interface BuildRuntimeToolFactoriesOptions {
  /** MCP client connected to the sidecar advertising the runtime-injected tools. */
  mcp: AppstrateMcpClient;
  /** Run id stamped on `<tool>.called` / `<tool>.completed` events. */
  runId: string;
  /** Telemetry sink for `<tool>.called` / `<tool>.completed` events. */
  emit: RuntimeToolEventEmitter;
  /**
   * Override the descriptor list. Defaults to {@link
   * RUNTIME_INJECTED_TOOLS} — the canonical set the platform prompt
   * builder also iterates. Tests use the override to register a
   * minimal subset.
   */
  tools?: ReadonlyArray<RuntimeInjectedTool>;
}

/**
 * Build one Pi extension factory per runtime-injected tool. Each
 * factory registers a Pi tool that forwards `tools/call` verbatim to
 * the MCP server, emitting `<tool>.called` / `<tool>.completed`
 * events around the call.
 *
 * The runtime container's `mcp/direct.ts` calls this with the default
 * `tools` set so adding a new runtime-injected tool to {@link
 * RUNTIME_INJECTED_TOOLS} automatically wires it through every
 * consumer.
 */
export function buildRuntimeToolFactories(
  opts: BuildRuntimeToolFactoriesOptions,
): ExtensionFactory[] {
  const tools = opts.tools ?? RUNTIME_INJECTED_TOOLS;
  return tools.map((tool) => makeMcpForwardExtension(tool, opts));
}

function makeMcpForwardExtension(
  tool: RuntimeInjectedTool,
  opts: BuildRuntimeToolFactoriesOptions,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      // `parameters` is plain JSON Schema in the descriptor; Pi accepts
      // it through `Type.Unsafe`, which preserves the schema verbatim
      // for the LLM tool advertisement without reinterpreting types.
      parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters as Record<string, unknown>),
      async execute(toolCallId, params, signal) {
        const startedAt = Date.now();
        opts.emit({
          type: `${tool.name}.called`,
          runId: opts.runId,
          toolCallId,
          timestamp: startedAt,
        });
        const result = await opts.mcp.callTool(
          { name: tool.name, arguments: (params as Record<string, unknown>) ?? {} },
          { ...(signal ? { signal } : {}) },
        );
        opts.emit({
          type: `${tool.name}.completed`,
          runId: opts.runId,
          toolCallId,
          durationMs: Date.now() - startedAt,
          isError: result.isError === true,
          timestamp: Date.now(),
        });
        return callToolResultToPi(result);
      },
    });
  };
}
