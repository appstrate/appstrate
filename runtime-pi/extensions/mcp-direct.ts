// SPDX-License-Identifier: Apache-2.0

/**
 * Direct MCP tool surface for new agent bundles (Phase 5 §D5.3 of #276).
 *
 * Two LLM-facing surfaces share the same MCP plumbing — pick whichever
 * matches the bundle's prompt vocabulary:
 *
 * - `mcp-bridge.ts` (legacy / D5.2 alias) — registers one Pi tool per
 *   declared provider as `<slug>_call`, internally calling
 *   `provider_call({ providerId: slug, … })`. Existing bundles refer
 *   to `appstrate_gmail_call`; this path keeps them working.
 * - `mcp-direct.ts` (this file, new / D5.3) — registers the MCP tool
 *   names verbatim. The LLM sees `provider_call({ providerId, … })`,
 *   `run_history(…)`, and `llm_complete(…)` exactly as the sidecar's
 *   `tools/list` advertises them. Matches the MCP ecosystem
 *   convention — Appstrate becomes indistinguishable (LLM-side) from
 *   any other MCP host.
 *
 * Both paths use the same {@link AppstrateMcpClient}; only the Pi-tool
 * registration shape differs. The toggle is the `RUNTIME_MCP_DIRECT_TOOLS`
 * env flag plumbed through `runtime-pi/env.ts`. Default OFF until Phase 6.
 *
 * What this module deliberately does NOT do:
 *   - Sniff `tools/list` and re-derive the input schema. The schemas
 *     here are pinned to the sidecar's `mountMcp(...)` advertisement
 *     so a divergence between Pi tools and MCP tools is a one-line fix
 *     here, not silent re-validation drift.
 *   - Build the system prompt. Per D5.1 we ship a 3-line capability
 *     prompt fragment via {@link DIRECT_TOOL_PROMPT}; the bundle owner
 *     decides whether to splice it in.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { Bundle } from "@appstrate/afps-runtime/bundle";
import type { AppstrateMcpClient, CallToolResult } from "@appstrate/mcp-transport";
import { readProviderRefs, type ProviderEventEmitter } from "@appstrate/runner-pi";

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

/** Coerce an MCP {@link CallToolResult} to the Pi `AgentToolResult` shape. */
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

interface BuildMcpDirectFactoriesOptions {
  bundle: Bundle;
  mcp: AppstrateMcpClient;
  runId: string;
  emitProvider: ProviderEventEmitter;
  emit: (event: { type: string; [k: string]: unknown }) => void;
}

/**
 * Build the `provider_call` + `run_history` + `llm_complete` Pi
 * extension factories. The set is built once per agent — toggle into
 * the per-provider legacy aliases via `mcp-bridge.ts` instead when a
 * bundle's prompt references `appstrate_<slug>_call`.
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
    factories.push(makeProviderCallExtension(providerIds, opts));
  }
  factories.push(makeRunHistoryExtension(opts));
  factories.push(makeLlmCompleteExtension(opts));
  return factories;
}

function makeProviderCallExtension(
  providerIds: string[],
  opts: BuildMcpDirectFactoriesOptions,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: PROVIDER_CALL_TOOL_NAME,
      label: PROVIDER_CALL_TOOL_NAME,
      description:
        "Make an authenticated request through the credential-injecting proxy. " +
        "Pick the provider via `providerId` (one of the declared providers in this run).",
      parameters: Type.Unsafe<Record<string, unknown>>({
        type: "object",
        additionalProperties: false,
        required: ["providerId", "target"],
        properties: {
          providerId: { type: "string", enum: providerIds },
          target: { type: "string", format: "uri" },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
          },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: { type: "string" },
          substituteBody: { type: "boolean" },
        },
      }),
      async execute(toolCallId, params, signal) {
        const args = params as { providerId: string } & Record<string, unknown>;
        const startedAt = Date.now();
        opts.emitProvider({
          type: "provider.called",
          runId: opts.runId,
          providerId: args.providerId,
          toolCallId,
          timestamp: startedAt,
        });
        try {
          const result = await opts.mcp.callTool(
            { name: PROVIDER_CALL_TOOL_NAME, arguments: args },
            { ...(signal ? { signal } : {}) },
          );
          opts.emitProvider({
            type: "provider.completed",
            runId: opts.runId,
            providerId: args.providerId,
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
            providerId: args.providerId,
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
