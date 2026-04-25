// SPDX-License-Identifier: Apache-2.0

/**
 * Direct MCP tool surface (the only LLM-facing surface).
 *
 * Registers `provider_call`, `run_history`, and `llm_complete` as
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
  type ProviderEventEmitter,
} from "@appstrate/runner-pi";
import { McpProviderResolver } from "./mcp-provider-resolver.ts";

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
const RUN_HISTORY_TOOL_NAME = "run_history";
const LLM_COMPLETE_TOOL_NAME = "llm_complete";

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
 * Build the `provider_call` + `run_history` + `llm_complete` Pi
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
 * empty), but always emits `run_history` + `llm_complete`.
 */
export async function buildMcpDirectFactories(
  opts: BuildMcpDirectFactoriesOptions,
): Promise<ExtensionFactory[]> {
  const refs = readProviderRefs(opts.bundle);
  const providerIds = refs.map((r) => r.name);

  // Discover the sidecar's tool surface so we can fail fast if the
  // expected tools are missing.
  const { tools } = await opts.mcp.listTools();
  const advertised = new Set(tools.map((t) => t.name));
  const expected = [RUN_HISTORY_TOOL_NAME, LLM_COMPLETE_TOOL_NAME];
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
  factories.push(makeRunHistoryExtension(opts));
  factories.push(makeLlmCompleteExtension(opts));
  return factories;
}

function makeRunHistoryExtension(opts: BuildMcpDirectFactoriesOptions): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: RUN_HISTORY_TOOL_NAME,
      label: RUN_HISTORY_TOOL_NAME,
      description:
        "Fetch metadata and optionally state/result of recent past runs (current run excluded).",
      parameters: Type.Unsafe<Record<string, unknown>>({
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50 },
          fields: {
            type: "array",
            items: { type: "string", enum: ["state", "result"] },
            uniqueItems: true,
          },
        },
      }),
      async execute(toolCallId, params, signal) {
        const startedAt = Date.now();
        opts.emit({
          type: "run_history.called",
          runId: opts.runId,
          toolCallId,
          timestamp: startedAt,
        });
        const result = await opts.mcp.callTool(
          { name: RUN_HISTORY_TOOL_NAME, arguments: (params as Record<string, unknown>) ?? {} },
          { ...(signal ? { signal } : {}) },
        );
        opts.emit({
          type: "run_history.completed",
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

function makeLlmCompleteExtension(opts: BuildMcpDirectFactoriesOptions): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: LLM_COMPLETE_TOOL_NAME,
      label: LLM_COMPLETE_TOOL_NAME,
      description:
        "Issue a completion request to the platform-configured LLM. " +
        "Synchronous: returns once the upstream response is fully received.",
      parameters: Type.Unsafe<Record<string, unknown>>({
        type: "object",
        additionalProperties: false,
        required: ["path", "body"],
        properties: {
          path: {
            type: "string",
            pattern: "^/[A-Za-z0-9._/-]{1,256}$",
          },
          method: { type: "string", enum: ["POST", "PUT", "PATCH"] },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: { type: "string" },
        },
      }),
      async execute(toolCallId, params, signal) {
        const startedAt = Date.now();
        opts.emit({
          type: "llm_complete.called",
          runId: opts.runId,
          toolCallId,
          timestamp: startedAt,
        });
        const result = await opts.mcp.callTool(
          { name: LLM_COMPLETE_TOOL_NAME, arguments: params as Record<string, unknown> },
          { ...(signal ? { signal } : {}) },
        );
        opts.emit({
          type: "llm_complete.completed",
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
