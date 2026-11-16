// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Adapters shared by every Pi tool that forwards to an MCP server: the
 * runtime container's integration tools (`runtime-pi/mcp/direct.ts`) and the
 * CLI's remote MCP tools.
 */

import {
  readToolIntegration,
  type AppstrateMcpClient,
  type CallToolResult,
  type Tool,
} from "@appstrate/mcp-transport";
import { piToolResultOrThrow, type PiToolContent, type PiToolResult } from "./pi-tool-result.ts";
import { unsafeSchema, type ExtensionFactory } from "./pi-sdk.ts";
import { spillResourcesToWorkspace } from "./resource-spill.ts";
import type { RuntimeEventEmitter } from "./runtime-event.ts";
import { registerIntegrationTool } from "./tool-integration.ts";

/**
 * Adapt an MCP `CallToolResult` into Pi's `AgentToolResult` shape. Pi
 * accepts only `text` and `image` content blocks; MCP can also return
 * `resource_link` and inline `resource` blocks, which we render as
 * text pointers (`[resource <uri>]`) so the LLM still sees the URI and
 * can fetch the resource via `resources/read` if it cares.
 *
 * Structured data: the MCP `structuredContent` is forwarded as Pi's
 * `details`. Be aware of what that does and does not buy — per the Pi
 * SDK, `AgentToolResult.details` is "arbitrary structured details for
 * logs or UI rendering"; the pi-ai providers serialize ONLY the
 * text/image `content` blocks into the LLM request, so nothing placed
 * in `details` ever reaches the model. Any data the model must see
 * (e.g. api_call's upstream status) must be rendered into a text block
 * by the caller — that is why the api_call response shaper keeps its
 * `[api_call status=…]` prefix and JSON-descriptor text block.
 *
 * Failure: an `isError: true` result throws through
 * {@link piToolResultOrThrow}, so Pi flags the call as failed.
 */
export function callToolResultToPi(result: CallToolResult): PiToolResult {
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
  return piToolResultOrThrow({
    content,
    details: result.structuredContent,
    isError: result.isError === true,
  });
}

/** What one call sends: its arguments and how its result is finished, or an error it ends with. */
export type McpToolCallPlan =
  | {
      args: Record<string, unknown>;
      /** Default: resources spilled to the workspace, then {@link callToolResultToPi}. */
      finish?: (result: CallToolResult, toolCallId: string) => Promise<PiToolResult>;
    }
  | { error: string };

export interface McpToolForwardOptions {
  mcp: Pick<AppstrateMcpClient, "callTool" | "readResource">;
  /** The descriptor the model sees; its host-stamped integration tool is recorded. */
  tool: Tool;
  /** The name called on the server. Default: `tool.name`. */
  upstreamName?: string;
  runId: string;
  /** Workspace root resources spill under. */
  workspace: string;
  emit: RuntimeEventEmitter;
  /** Adapts a call's arguments and result. Default: forwarded verbatim. */
  plan?: (args: Record<string, unknown>) => Promise<McpToolCallPlan>;
}

/**
 * A Pi tool forwarding each call to an MCP client, between `integration_tool.called` and
 * `integration_tool.completed` events.
 */
export function mcpToolForwardFactory(opts: McpToolForwardOptions): ExtensionFactory {
  const { mcp, tool, runId, emit } = opts;
  return (pi) => {
    registerIntegrationTool(pi, readToolIntegration(tool), {
      name: tool.name,
      label: tool.name,
      description: tool.description ?? `Integration tool: ${tool.name}`,
      parameters: unsafeSchema<Record<string, unknown>>(tool.inputSchema),
      async execute(toolCallId, params, signal) {
        const startedAt = Date.now();
        const event = { runId, tool: tool.name, toolCallId };
        emit({ type: "integration_tool.called", ...event, timestamp: startedAt });
        const completed = (isError: boolean) =>
          emit({
            type: "integration_tool.completed",
            ...event,
            durationMs: Date.now() - startedAt,
            isError,
            timestamp: Date.now(),
          });
        const args = (params as Record<string, unknown>) ?? {};
        const outcome = await (async () => {
          const call = opts.plan ? await opts.plan(args) : { args };
          if ("error" in call) return call;
          // Requesting progress makes the client's per-call timeout an idle one, restarted by each
          // notification: a long call that reports progress is kept alive within Pi's `signal`.
          const result = await mcp.callTool(
            { name: opts.upstreamName ?? tool.name, arguments: call.args },
            { ...(signal ? { signal } : {}), onProgress: () => {} },
          );
          return { call, result };
        })().catch((err: unknown) => {
          completed(true);
          throw err;
        });
        if ("error" in outcome) {
          completed(true);
          return callToolResultToPi({
            content: [{ type: "text", text: outcome.error }],
            isError: true,
          });
        }
        const { call, result } = outcome;
        completed(result.isError === true);
        if (call.finish) return call.finish(result, toolCallId);
        // Resources become workspace files before the adapter flattens them: embedded `resource`
        // blocks, and `resource_link` blocks read through `resources/read`.
        const spilled = await spillResourcesToWorkspace(result, {
          workspace: opts.workspace,
          toolCallId,
          emit,
          runId,
          readResource: (uri) => mcp.readResource({ uri }),
        });
        return callToolResultToPi(spilled);
      },
    });
  };
}
