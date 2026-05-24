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
  spillResourcesToWorkspace,
  type RuntimeEventEmitter,
} from "@appstrate/runner-pi";
import { reEmitRuntimeToolEvents } from "@appstrate/core/runtime-tool-defs";
import { isSelectableRuntimeTool } from "@appstrate/core/runtime-tools-catalog";
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
  emit: RuntimeEventEmitter;
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
  // Platform runtime tools (output/log/note/pin/report) the sidecar hosts as
  // MCP tools (`@appstrate/core/runtime-tool-defs`). They are FIRST-PARTY —
  // served in-process by the credential-isolated sidecar — so re-emitting the
  // canonical events they return under the result `_meta` key is safe. They
  // are wired by a dedicated factory builder, deliberately separate from the
  // integration-tool path below which must NEVER re-emit a third-party result.
  factories.push(...buildRuntimeMcpToolFactories(tools, opts));
  // Phase 1.4 — integration tools. The sidecar's McpHost multiplexes
  // each spawned `type: integration` MCP server's tools as namespaced
  // entries (`{ns}__{tool}`). We mirror them as Pi tools that forward
  // verbatim to the sidecar's MCP `tools/call`. Any name we already wired
  // above (run_history / recall_memory / the runtime tools) is skipped.
  const claimedNames = new Set<string>([
    ...RUNTIME_INJECTED_TOOLS.map((t) => t.name),
    ...tools.filter((t) => isSelectableRuntimeTool(t.name)).map((t) => t.name),
  ]);
  factories.push(...buildIntegrationToolFactories(tools, claimedNames, opts));
  return factories;
}

/**
 * Wrap the sidecar-hosted platform runtime tools (output/log/note/pin/report)
 * as Pi extensions that forward to `mcp.callTool` and re-emit the canonical
 * run events they return under the result `_meta` key into the run's single
 * sink. These tools are FIRST-PARTY (served in-process by the credential-
 * isolated sidecar from `@appstrate/core/runtime-tool-defs`), so re-emitting
 * their `_meta` events is safe — unlike third-party integration tools, whose
 * results must never be trusted to inject run events (see
 * {@link buildIntegrationToolFactories}, which deliberately does NOT re-emit).
 */
function buildRuntimeMcpToolFactories(
  advertised: ReadonlyArray<{ name: string; description?: string; inputSchema?: unknown }>,
  opts: BuildMcpDirectFactoriesOptions,
): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  for (const tool of advertised) {
    if (!isSelectableRuntimeTool(tool.name)) continue;
    factories.push((pi) => {
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description ?? `Runtime tool: ${tool.name}`,
        parameters: Type.Unsafe<Record<string, unknown>>(
          (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        ),
        async execute(_toolCallId, params, signal) {
          const result = await opts.mcp.callTool(
            { name: tool.name, arguments: (params as Record<string, unknown>) ?? {} },
            { ...(signal ? { signal } : {}) },
          );
          // First-party runtime tool: re-emit its canonical events into the
          // run's single sink (preserving one sequence source) so ingestion /
          // the reducer / finalize behave exactly as the former baked-in Pi
          // extensions did. Stamp `runId` + `timestamp`: every canonical
          // RunEvent requires them (the reducer copies `timestamp` into
          // `RunResult.logs[]`, which finalize validates as a number); the
          // transport-neutral defs omit both.
          reEmitRuntimeToolEvents(result._meta, (e) =>
            opts.emit({
              ...e,
              runId: opts.runId,
              timestamp: typeof e.timestamp === "number" ? e.timestamp : Date.now(),
            }),
          );
          return callToolResultToPi(result);
        },
      });
    });
  }
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
          // NOTE: a third-party integration result's `_meta` is NEVER
          // re-emitted as run events — that would let a compromised
          // integration forge `output.emitted` / `pinned.set` / `memory.added`
          // / `report.appended` / `log.written` events (persistent prompt
          // injection, output tampering). Only the first-party runtime tools
          // hosted by the sidecar re-emit, via buildRuntimeMcpToolFactories.
          //
          // Materialise MCP resources to workspace files before the adapter
          // flattens them, keeping file bytes out of the LLM context:
          //  - embedded `resource` blocks (GitHub MCP `get_file_contents`, …),
          //  - `resource_link` blocks (e.g. `{ns}__api_call` spilling a
          //    response > 32 KB to the sidecar blob store) — fetched via
          //    `readResource` so the agent grep/head/tail/reads the file
          //    instead of receiving an unreadable `appstrate://` URI.
          const spilled = await spillResourcesToWorkspace(result, {
            workspace: opts.workspace,
            toolCallId,
            emit: opts.emit,
            runId: opts.runId,
            readResource: (uri) => opts.mcp.readResource({ uri }),
          });
          return callToolResultToPi(spilled);
        },
      });
    });
  }
  return factories;
}
