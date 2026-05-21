// SPDX-License-Identifier: Apache-2.0

/**
 * Direct MCP tool surface (the only LLM-facing surface).
 *
 * Registers `run_history` and `recall_memory` as Pi-SDK tools, each
 * forwarding to the sidecar's MCP `tools/call` endpoint via
 * {@link AppstrateMcpClient}, plus any namespaced `{ns}__{tool}` entry
 * advertised by a spawned AFPS integration. The LLM sees the canonical
 * MCP names verbatim — Appstrate is indistinguishable (LLM-side) from
 * any other MCP host.
 *
 * What this module deliberately does NOT do:
 *   - Sniff `tools/list` and re-derive the input schema for first-party
 *     tools. The schemas there are pinned to the sidecar's
 *     `mountMcp(...)` advertisement so a divergence between Pi tools and
 *     MCP tools is a one-line fix here, not silent re-validation drift.
 *   - Build the system prompt. We ship a 3-line capability prompt
 *     fragment via {@link DIRECT_TOOL_PROMPT}; the bundle owner
 *     decides whether to splice it in.
 *
 * The per-tool wiring (event emit → `mcp.callTool` → result-shape
 * adapter) for the runtime-injected tools lives in
 * `@appstrate/runner-pi/runtime-tools/mcp-forward`. This file is
 * orchestration-only.
 */

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { AppstrateMcpClient } from "@appstrate/mcp-transport";
import { Type } from "@mariozechner/pi-ai";
import {
  buildRuntimeToolFactories,
  callToolResultToPi,
  RUNTIME_INJECTED_TOOLS,
} from "@appstrate/runner-pi";
import { buildApiUploadToolFactory, isApiUploadToolName } from "./api-upload-extension.ts";

/**
 * 3-line capability prompt (D5.1). Spliceable into a bundle's system
 * prompt — Sonnet 4+ tier models infer the rest from `tools/list`
 * natively.
 */
export const DIRECT_TOOL_PROMPT = [
  "## Capabilities",
  "You have access to MCP tools through the standard MCP protocol.",
  "Discover them via `tools/list`. Each tool's input schema is self-documenting.",
].join("\n");

interface BuildMcpDirectFactoriesOptions {
  mcp: AppstrateMcpClient;
  runId: string;
  emit: (event: { type: string; [k: string]: unknown }) => void;
  /**
   * Workspace root the agent's files live under. Required to resolve the
   * `fromFile` argument of `{ns}__api_upload` tools (resumable upload) —
   * the sidecar advertises those tools but the chunked upload is
   * orchestrated agent-side because the workspace is not visible to the
   * credential-isolated sidecar.
   */
  workspace: string;
}

/**
 * Build the `run_history` + `recall_memory` Pi extension factories plus
 * one forwarding factory per namespaced integration tool. The set is
 * built once per agent.
 *
 * `run_history` and `recall_memory` are wired by `runner-pi`'s
 * `buildRuntimeToolFactories`, which iterates {@link
 * RUNTIME_INJECTED_TOOLS} and produces one Pi-tool registration per
 * descriptor.
 */
export async function buildMcpDirectFactories(
  opts: BuildMcpDirectFactoriesOptions,
): Promise<ExtensionFactory[]> {
  // Discover the sidecar's tool surface so we can fail fast if the
  // expected tools are missing. The expected set is derived from the
  // shared `RUNTIME_INJECTED_TOOLS` descriptor list — adding a new
  // runtime tool to that list automatically updates this guard.
  const { tools } = await opts.mcp.listTools();
  const advertised = new Set(tools.map((t) => t.name));
  const expected = RUNTIME_INJECTED_TOOLS.map((t) => t.name);
  for (const name of expected) {
    if (!advertised.has(name)) {
      throw new Error(
        `MCP server does not advertise '${name}'. ` +
          `Tools available: ${[...advertised].join(", ") || "(none)"}`,
      );
    }
  }

  const factories: ExtensionFactory[] = [];
  factories.push(
    ...buildRuntimeToolFactories({
      mcp: opts.mcp,
      runId: opts.runId,
      emit: opts.emit,
    }),
  );
  // Phase 1.4 — integration tools. The sidecar's McpHost multiplexes
  // each spawned `type: integration` MCP server's tools as namespaced
  // entries (`{ns}__{tool}`). We mirror them as Pi tools that forward
  // verbatim to the sidecar's MCP `tools/call`. Any name we already
  // wired above (run_history / recall_memory) is skipped.
  const claimedNames = new Set<string>(RUNTIME_INJECTED_TOOLS.map((t) => t.name));
  factories.push(...buildIntegrationToolFactories(tools, claimedNames, opts));
  return factories;
}

/**
 * Wrap every non-first-party tool advertised by the sidecar's MCP host
 * as a Pi extension that forwards to `mcp.callTool` verbatim. This is
 * how `{namespace}__{tool}` entries from spawned integration MCP servers
 * (including the generic `{ns}__api_call` tool) become callable from the
 * LLM side (Phase 1.4).
 */
function buildIntegrationToolFactories(
  advertised: ReadonlyArray<{ name: string; description?: string; inputSchema?: unknown }>,
  claimed: ReadonlySet<string>,
  opts: BuildMcpDirectFactoriesOptions,
): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  for (const tool of advertised) {
    if (claimed.has(tool.name)) continue;
    // `{ns}__api_upload` tools are advertised by the sidecar (so the
    // gating + schema live in one place) but executed agent-side: the
    // resolver reads the workspace file, chunks it, and dispatches each
    // chunk back through the sibling `{ns}__api_call` tool. Route them to
    // the dedicated resolver instead of forwarding verbatim (a verbatim
    // forward would hit the sidecar's advertise-only error handler).
    if (isApiUploadToolName(tool.name)) {
      factories.push(
        ...buildApiUploadToolFactory({
          tool,
          mcp: opts.mcp,
          runId: opts.runId,
          workspace: opts.workspace,
          emit: opts.emit,
        }),
      );
      continue;
    }
    factories.push((pi) => {
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description ?? `Integration tool: ${tool.name}`,
        parameters: Type.Unsafe<Record<string, unknown>>(
          (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        ),
        async execute(toolCallId, params, signal) {
          const startedAt = Date.now();
          opts.emit({
            type: `integration_tool.called`,
            runId: opts.runId,
            tool: tool.name,
            toolCallId,
            timestamp: startedAt,
          });
          const result = await opts.mcp.callTool(
            { name: tool.name, arguments: (params as Record<string, unknown>) ?? {} },
            { ...(signal ? { signal } : {}) },
          );
          opts.emit({
            type: `integration_tool.completed`,
            runId: opts.runId,
            tool: tool.name,
            toolCallId,
            durationMs: Date.now() - startedAt,
            isError: result.isError === true,
            timestamp: Date.now(),
          });
          return callToolResultToPi(result);
        },
      });
    });
  }
  return factories;
}
