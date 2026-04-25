// SPDX-License-Identifier: Apache-2.0

/**
 * MCP-backed equivalents of {@link buildProviderExtensionFactories} and
 * {@link buildRunHistoryExtensionFactory} (Phase 2 of #276).
 *
 * Drop-in replacements: the LLM still sees `appstrate_<slug>_call` and
 * `run_history` Pi tools (Phase 5 retires that surface). Internally,
 * each Pi tool now invokes a single MCP `tools/call` against the
 * sidecar's `/mcp` endpoint instead of bespoke HTTP routes — same
 * outcome, one wire format.
 *
 * What changes versus `provider-bridge`:
 *   - The HTTP hop is `/mcp` (Streamable HTTP, JSON-RPC) instead of
 *     `/proxy` (custom REST headers).
 *   - The provider tool name advertised on `tools/list` is the generic
 *     `provider_call`; we wrap it per-provider in a Pi extension whose
 *     `name` matches the legacy `<slug>_call` convention so the LLM-
 *     facing surface is identical.
 *   - Cancellation is propagated via the Pi `signal` parameter into the
 *     MCP `callTool` call — the SDK forwards it as `notifications/cancelled`.
 *
 * Why mirror the legacy surface verbatim: this phase is architectural
 * plumbing. We validate end-to-end MCP wiring before changing the LLM-
 * facing tool names. Phase 5 swaps the LLM to MCP names directly.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { Bundle } from "@appstrate/afps-runtime/bundle";
import type { AppstrateMcpClient, CallToolResult } from "@appstrate/mcp-transport";
import { readProviderRefs, type ProviderEventEmitter } from "@appstrate/runner-pi";

const RUN_HISTORY_TOOL_NAME = "run_history";
const PROVIDER_CALL_TOOL_NAME = "provider_call";

/**
 * Convert a slug like `@appstrate/gmail` or `appstrate-gmail` into the
 * Pi-tool name `appstrate_gmail_call` — same canonicalisation as
 * `SidecarProviderResolver`. Mirrors the existing LLM-facing surface so
 * agent prompts referring to `appstrate_gmail_call` keep working.
 */
function providerToolName(rawSlug: string): string {
  const slug = rawSlug
    .replace(/^@/, "")
    .replace(/[/.\s]+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return `${slug}_call`;
}

/** Coerce an MCP `CallToolResult` to the Pi `AgentToolResult` shape. */
function callToolResultToPi(result: CallToolResult): {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  details: undefined;
} {
  const content = result.content.map((c) => {
    if (c.type === "text") return { type: "text" as const, text: c.text };
    if (c.type === "image") return { type: "image" as const, data: c.data, mimeType: c.mimeType };
    if (c.type === "resource_link") {
      return {
        type: "text" as const,
        text: `[resource ${c.uri}${c.name ? ` (${c.name})` : ""}]`,
      };
    }
    if (c.type === "resource") {
      const inner = c.resource;
      return {
        type: "text" as const,
        text: `[resource ${inner.uri}${"text" in inner && inner.text ? `\n${inner.text}` : ""}]`,
      };
    }
    return {
      type: "text" as const,
      text: `[unknown content type: ${(c as { type: string }).type}]`,
    };
  });
  return { content, details: undefined };
}

interface BuildMcpProviderFactoriesOptions {
  bundle: Bundle;
  mcp: AppstrateMcpClient;
  runId: string;
  workspace: string;
  emitProvider: ProviderEventEmitter;
}

/**
 * Build one Pi {@link ExtensionFactory} per declared provider, all
 * backed by the same MCP client. Returns `[]` when the bundle declares
 * no providers (safe to splice unconditionally).
 *
 * Each generated tool exposes a JSON Schema mirroring the legacy
 * `<slug>_call` shape so the LLM contract is unchanged. Internally
 * `arguments.providerId` is filled in from the slug — invisible to the
 * model.
 */
export async function buildMcpProviderFactories(
  opts: BuildMcpProviderFactoriesOptions,
): Promise<ExtensionFactory[]> {
  const refs = readProviderRefs(opts.bundle);
  if (refs.length === 0) return [];

  // Discover the sidecar's tool surface so we can fail fast if the
  // expected `provider_call` tool is missing — better than a confusing
  // `Tool not found` on the first agent invocation.
  const { tools } = await opts.mcp.listTools();
  const hasProviderCall = tools.some((t) => t.name === PROVIDER_CALL_TOOL_NAME);
  if (!hasProviderCall) {
    throw new Error(
      `MCP server does not advertise '${PROVIDER_CALL_TOOL_NAME}'. ` +
        `Tools available: ${tools.map((t) => t.name).join(", ") || "(none)"}`,
    );
  }

  return refs.map((ref) => makeProviderExtension(ref.name, opts));
}

function makeProviderExtension(
  providerSlug: string,
  opts: BuildMcpProviderFactoriesOptions,
): ExtensionFactory {
  const piToolName = providerToolName(providerSlug);
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: piToolName,
      label: piToolName,
      description:
        `Make an authenticated request through the sidecar's credential-injecting proxy ` +
        `for provider '${providerSlug}'. Routed via MCP \`tools/call\`.`,
      parameters: Type.Unsafe<Record<string, unknown>>({
        type: "object",
        additionalProperties: false,
        required: ["target"],
        properties: {
          target: { type: "string", format: "uri" },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
          },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
          },
          body: { type: "string" },
          substituteBody: { type: "boolean" },
        },
      }),
      async execute(toolCallId, params, signal) {
        const startedAt = Date.now();
        opts.emitProvider({
          type: "provider.called",
          runId: opts.runId,
          providerId: providerSlug,
          toolCallId,
          timestamp: startedAt,
        });
        try {
          const result = await opts.mcp.callTool(
            {
              name: PROVIDER_CALL_TOOL_NAME,
              arguments: { providerId: providerSlug, ...(params as Record<string, unknown>) },
            },
            { ...(signal ? { signal } : {}) },
          );
          opts.emitProvider({
            type: "provider.completed",
            runId: opts.runId,
            providerId: providerSlug,
            toolCallId,
            durationMs: Date.now() - startedAt,
            isError: result.isError === true,
            timestamp: Date.now(),
          });
          return callToolResultToPi(result);
        } catch (err) {
          opts.emitProvider({
            type: "provider.failed",
            runId: opts.runId,
            providerId: providerSlug,
            toolCallId,
            durationMs: Date.now() - startedAt,
            error: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          });
          throw err;
        }
      },
    });
  };
}

interface BuildMcpRunHistoryFactoryOptions {
  mcp: AppstrateMcpClient;
  runId: string;
  emit: (event: { type: string; [k: string]: unknown }) => void;
}

/**
 * Build the `run_history` Pi extension factory backed by the same MCP
 * client. Mirrors `buildRunHistoryExtensionFactory` semantics — the
 * agent calls `run_history({ limit, fields })` and gets a JSON text
 * response.
 */
export function buildMcpRunHistoryFactory(
  opts: BuildMcpRunHistoryFactoryOptions,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: RUN_HISTORY_TOOL_NAME,
      label: RUN_HISTORY_TOOL_NAME,
      description:
        "Fetch metadata and optionally state/result of recent past runs (current run excluded). Routed via MCP.",
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
          {
            name: RUN_HISTORY_TOOL_NAME,
            arguments: (params as Record<string, unknown>) ?? {},
          },
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

export { providerToolName };
