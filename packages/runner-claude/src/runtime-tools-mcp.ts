// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Host the platform runtime tools (`log` / `note` / `pin` / `report`) as an
 * IN-PROCESS MCP server for the Claude Agent SDK.
 *
 * Why in-process (not via the sidecar `/mcp` like integrations): a runtime
 * tool's effect is the canonical {@link RunEvent} it produces (a log line, a
 * pinned slot, …), carried back under the `_meta` key. The Agent SDK's HTTP
 * MCP client DROPS `_meta` (Phase-0 spike `META_DROPPED`), so a sidecar-hosted
 * runtime tool would silently lose every event. Hosting the same
 * `@appstrate/core/runtime-tool-defs` definitions in-process (spike
 * `INSTANCE_OK`) lets the handler re-emit those events DIRECTLY to the run's
 * sink — `_meta` never has to survive a transport.
 *
 * `output` is deliberately excluded: the Claude runner takes the structured
 * deliverable natively off `result.structured_output` via the SDK's
 * `outputFormat` (spike `OUTPUT_NATIVE_OK`), so registering an `output` tool
 * here would be a redundant, conflicting second path to the same result.
 */

import type { RunEvent } from "@appstrate/afps-runtime/types";
import { createMcpServer, type AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { buildRuntimeToolDefs, reEmitRuntimeToolEvents } from "@appstrate/core/runtime-tool-defs";

/** The live in-process MCP server type (from `createMcpServer`, no direct MCP-SDK import). */
type McpServerInstance = ReturnType<typeof createMcpServer>;

/** Runtime tools the Claude runner hosts in-process. `output` is native (excluded). */
const IN_PROCESS_RUNTIME_TOOLS = new Set(["log", "note", "pin", "report"]);

export interface RuntimeToolsMcpOptions {
  /** Agent-selected runtime tools (`manifest.runtime_tools`). `output` is ignored here. */
  runtimeTools?: readonly string[];
  /**
   * Sink for the canonical events each tool call produces. The runner passes
   * the same emitter it uses for mapped SDK events, so runtime-tool events land
   * in the run's single ordered event stream (and feed the reducer).
   */
  emit: (event: RunEvent) => Promise<void>;
  /** MCP server name the SDK addresses (`mcpServers` key). Defaults to `appstrate_runtime`. */
  serverName?: string;
}

export interface RuntimeToolsMcp {
  /** Live in-process MCP server — pass as `{ type: "sdk", name, instance }`. */
  server: McpServerInstance;
  /** Server name to use as the `mcpServers` key. */
  name: string;
  /** Tool names registered (for logging / assertions). */
  toolNames: string[];
}

/**
 * Build the MCP tool definitions for the agent's in-process runtime tools,
 * each wrapped so its canonical events are re-emitted to the run sink. Returns
 * `[]` when no in-process runtime tools are selected.
 *
 * Exported (and transport-free) so the re-emit wiring — the part that matters —
 * is unit-testable by calling a handler directly, without standing up an MCP
 * transport. {@link buildRuntimeToolsMcpServer} is the thin glue that hands
 * these to `createMcpServer`.
 */
export function buildRuntimeToolDefinitions(opts: {
  runtimeTools?: readonly string[];
  emit: (event: RunEvent) => Promise<void>;
}): AppstrateToolDefinition[] {
  const selected = (opts.runtimeTools ?? []).filter((t) => IN_PROCESS_RUNTIME_TOOLS.has(t));
  if (selected.length === 0) return [];

  return buildRuntimeToolDefs({ runtimeTools: selected }).map((def) => ({
    // `buildRuntimeToolDefs` always emits a `{ type: "object", … }` JSON Schema
    // (its `inputSchema` is typed loosely as `Record<string, unknown>` to keep
    // core decoupled from the MCP `Tool` type); narrow it for `createMcpServer`,
    // which also validates the shape at registration time.
    descriptor: def.descriptor as AppstrateToolDefinition["descriptor"],
    handler: async (args) => {
      const result = await def.handler(args);
      // Re-emit the tool's canonical events straight to the run sink. The
      // handler is async, so we collect the (async) sink writes and await them
      // before returning the tool result — keeping event ordering deterministic
      // relative to the tool's completion.
      const pending: Promise<void>[] = [];
      reEmitRuntimeToolEvents(result._meta, (ev) => {
        pending.push(opts.emit(ev as RunEvent));
      });
      await Promise.all(pending);
      // Strip `_meta` — the SDK drops it anyway, and the events have already
      // been delivered to the sink. Return only the model-facing text.
      return {
        content: result.content,
        ...(result.isError ? { isError: true } : {}),
      };
    },
  }));
}

/**
 * Build the in-process runtime-tools MCP server, or `null` when the agent
 * selected no in-process runtime tools (the runner then omits it entirely).
 */
export function buildRuntimeToolsMcpServer(opts: RuntimeToolsMcpOptions): RuntimeToolsMcp | null {
  const toolDefs = buildRuntimeToolDefinitions({
    ...(opts.runtimeTools ? { runtimeTools: opts.runtimeTools } : {}),
    emit: opts.emit,
  });
  if (toolDefs.length === 0) return null;

  const name = opts.serverName ?? "appstrate_runtime";
  const server = createMcpServer(toolDefs, { name: "appstrate-runtime-tools", version: "0.0.0" });
  return { server, name, toolNames: toolDefs.map((d) => d.descriptor.name) };
}
