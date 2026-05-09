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
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { Bundle } from "@appstrate/afps-runtime/bundle";
import type { AppstrateMcpClient, CallToolResult } from "@appstrate/mcp-transport";
import {
  buildProviderCallExtensionFactory,
  readProviderRefs,
  RUNTIME_INJECTED_TOOLS,
  type ProviderEventEmitter,
  type RuntimeInjectedTool,
} from "@appstrate/runner-pi";
import { McpProviderResolver } from "./provider-resolver.ts";

// ─── MCP CallToolResult → Pi AgentToolResult adapter ──────────────────
// Folded in from the prior `./mcp-result.ts` module (single consumer
// after the alias layer was retired). Pi's `AgentToolResult.content`
// accepts only `text` and `image` blocks; MCP can also return
// `resource_link` and inline `resource` blocks, which we render as
// text pointers ("[resource <uri>]") so the LLM still sees the URI
// and can request the resource via `resources/read` if it cares.

type PiToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface PiToolResult {
  content: PiToolContent[];
  details: undefined;
}

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
 * Returns `[]` for `provider_call` when the bundle declares no
 * providers (so the LLM doesn't see a tool whose `providerId` enum is
 * empty), but always emits the two platform tools.
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
  }
  for (const tool of RUNTIME_INJECTED_TOOLS) {
    factories.push(makeMcpForwardExtension(tool, opts));
  }
  return factories;
}

/**
 * Generic extension factory for MCP-forwarding runtime-injected tools.
 *
 * One descriptor → one Pi-tool registration that:
 *   1. emits a `<tool.name>.called` event with `toolCallId`/`runId`,
 *   2. forwards the call verbatim to the sidecar via MCP `tools/call`,
 *   3. emits a `<tool.name>.completed` event with duration + isError,
 *   4. adapts the MCP `CallToolResult` to Pi's `AgentToolResult` shape.
 *
 * Pulling these into a single factory means adding a new runtime-
 * injected tool requires zero edits here — append to
 * `RUNTIME_INJECTED_TOOLS` and the registration loop above picks it up.
 */
function makeMcpForwardExtension(
  tool: RuntimeInjectedTool,
  opts: BuildMcpDirectFactoriesOptions,
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
