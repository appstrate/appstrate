// SPDX-License-Identifier: Apache-2.0

/**
 * Direct MCP tool surface (the only LLM-facing surface).
 *
 * Registers `provider_call`, `run_history`, and `recall_memory` as
 * Pi-SDK tools, each forwarding to the sidecar's MCP `tools/call`
 * endpoint via {@link AppstrateMcpClient}. The LLM sees the canonical
 * MCP names verbatim — Appstrate is indistinguishable (LLM-side) from
 * any other MCP host.
 *
 * What this module deliberately does NOT do:
 *   - Sniff `tools/list` and re-derive the input schema. The schemas
 *     here are pinned to the sidecar's `mountMcp(...)` advertisement
 *     so a divergence between Pi tools and MCP tools is a one-line fix
 *     here, not silent re-validation drift.
 *   - Build the system prompt. We ship a 3-line capability prompt
 *     fragment via {@link DIRECT_TOOL_PROMPT}; the bundle owner
 *     decides whether to splice it in.
 *
 * The per-tool wiring (event emit → `mcp.callTool` → result-shape
 * adapter) lives in `@appstrate/runner-pi/runtime-tools/mcp-forward`,
 * symmetric with the bundle-driven `provider_call` factory in
 * `runner-pi/provider-bridge`. This file is orchestration-only.
 */

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { Bundle } from "@appstrate/afps-runtime/bundle";
import type { AppstrateMcpClient } from "@appstrate/mcp-transport";
import { Type } from "@mariozechner/pi-ai";
import {
  buildProviderCallExtensionFactory,
  buildRuntimeToolFactories,
  callToolResultToPi,
  readProviderRefs,
  RUNTIME_INJECTED_TOOLS,
  type ProviderEventEmitter,
} from "@appstrate/runner-pi";
import { McpProviderResolver } from "./provider-resolver.ts";
import { buildProviderUploadExtensionFactory } from "./provider-upload-extension.ts";

const PROVIDER_CALL_TOOL_NAME = "provider_call";

/**
 * 3-line capability prompt (D5.1). Spliceable into a bundle's system
 * prompt to drop the per-provider sections currently shipped — Sonnet
 * 4+ tier models infer the rest from `tools/list` natively.
 */
export const DIRECT_TOOL_PROMPT = [
  "## Capabilities",
  "You have access to MCP tools through the standard MCP protocol.",
  "Discover them via `tools/list`. Each tool's input schema is self-documenting.",
].join("\n");

interface BuildMcpDirectFactoriesOptions {
  bundle: Bundle;
  mcp: AppstrateMcpClient;
  runId: string;
  /**
   * Workspace root used by `provider_call` for path-safe `{ fromFile }`
   * / `{ multipart }` body resolution. Required: the container's
   * `provider_call` Pi tool delegates to AFPS's resolver so the
   * `fromFile` contract documented in the sidecar README behaves
   * identically to the CLI path.
   */
  workspace: string;
  emitProvider: ProviderEventEmitter;
  emit: (event: { type: string; [k: string]: unknown }) => void;
}

/**
 * Build the `provider_call` + `run_history` + `recall_memory` Pi
 * extension factories. The set is built once per agent.
 *
 * `provider_call` delegates to `runner-pi`'s
 * `buildProviderCallExtensionFactory` (the same factory CLI mode uses)
 * with an `McpProviderResolver` that forwards every call over MCP.
 * That single factory is the canonical Pi-tool wiring for AFPS
 * `provider_call`, so the LLM-facing schema (including `body` accepting
 * `{ fromFile | fromBytes | multipart | string }`) and observability
 * are identical across execution modes.
 *
 * `run_history` and `recall_memory` are wired by `runner-pi`'s
 * `buildRuntimeToolFactories`, which iterates {@link
 * RUNTIME_INJECTED_TOOLS} and produces one Pi-tool registration per
 * descriptor.
 *
 * Returns `[]` for `provider_call` when the bundle declares no
 * providers (so the LLM doesn't see a tool whose `providerId` enum is
 * empty), but always emits the runtime-injected tools.
 */
export async function buildMcpDirectFactories(
  opts: BuildMcpDirectFactoriesOptions,
): Promise<ExtensionFactory[]> {
  const refs = readProviderRefs(opts.bundle);
  const providerIds = refs.map((r) => r.name);

  // Discover the sidecar's tool surface so we can fail fast if the
  // expected tools are missing. The expected set is derived from the
  // shared `RUNTIME_INJECTED_TOOLS` descriptor list — adding a new
  // runtime tool to that list automatically updates this guard.
  const { tools } = await opts.mcp.listTools();
  const advertised = new Set(tools.map((t) => t.name));
  const expected = RUNTIME_INJECTED_TOOLS.map((t) => t.name);
  if (providerIds.length > 0) expected.push(PROVIDER_CALL_TOOL_NAME);
  for (const name of expected) {
    if (!advertised.has(name)) {
      throw new Error(
        `MCP server does not advertise '${name}'. ` +
          `Tools available: ${[...advertised].join(", ") || "(none)"}`,
      );
    }
  }

  const factories: ExtensionFactory[] = [];
  if (providerIds.length > 0) {
    const providerFactories = await buildProviderCallExtensionFactory({
      bundle: opts.bundle,
      providerResolver: new McpProviderResolver(opts.mcp),
      runId: opts.runId,
      workspace: opts.workspace,
      emitProvider: opts.emitProvider,
    });
    factories.push(...providerFactories);

    // `provider_upload` is gated by the bundle's manifest declaring
    // `definition.uploadProtocols` on at least one provider — when
    // none does, the factory list is empty and the tool never
    // appears in `tools/list`. This avoids advertising a capability
    // the LLM can't actually use.
    const uploadFactories = buildProviderUploadExtensionFactory({
      bundle: opts.bundle,
      providerRefs: refs,
      mcp: opts.mcp,
      runId: opts.runId,
      workspace: opts.workspace,
      emit: opts.emit,
    });
    factories.push(...uploadFactories);
  }
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
  // wired above (provider_call / run_history / recall_memory / the
  // optional provider_upload) is skipped.
  const claimedNames = new Set<string>([
    PROVIDER_CALL_TOOL_NAME,
    ...RUNTIME_INJECTED_TOOLS.map((t) => t.name),
    // provider_upload is registered above when uploadFactories is non-empty
    "provider_upload",
  ]);
  factories.push(...buildIntegrationToolFactories(tools, claimedNames, opts));
  return factories;
}

/**
 * Wrap every non-first-party tool advertised by the sidecar's MCP host
 * as a Pi extension that forwards to `mcp.callTool` verbatim. This is
 * how `{namespace}__{tool}` entries from spawned integration MCP servers
 * become callable from the LLM side (Phase 1.4).
 */
function buildIntegrationToolFactories(
  advertised: ReadonlyArray<{ name: string; description?: string; inputSchema?: unknown }>,
  claimed: ReadonlySet<string>,
  opts: BuildMcpDirectFactoriesOptions,
): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  for (const tool of advertised) {
    if (claimed.has(tool.name)) continue;
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
