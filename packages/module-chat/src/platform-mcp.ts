// SPDX-License-Identifier: Apache-2.0

/**
 * Client to the platform's own MCP server (`/api/mcp`, Streamable HTTP) —
 * ported from the appstrate-chat satellite (lib/appstrate-mcp.ts).
 *
 * The platform exposes its REST surface through progressive MCP tools
 * (`search_operations` / `describe_operation` / `invoke_operation`) plus the
 * run-specific `run_and_wait` shortcut. We hand them to `streamText` so the
 * model can drive Appstrate — list agents, inspect runs, search documents,
 * schedule — with the caller's own permissions. `run_and_wait` is wrapped
 * locally after discovery so it can emit an AI SDK preliminary result as soon as
 * the run id exists; that is what lets the chat render live logs while the final
 * tool result is still blocked on completion. The wrapper still uses the public
 * REST routes with the caller's forwarded auth/RBAC context.
 */

import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { runAndWaitSteps } from "@appstrate/core/run-and-wait-client";
import type { ToolCallRepairFunction, ToolSet as AiToolSet } from "ai";
import { logger } from "./logger.ts";

type ToolSet = Awaited<ReturnType<MCPClient["tools"]>>;

export interface McpHandle {
  /** AI SDK ToolSet, ready for `streamText({ tools })`. */
  tools: ToolSet;
  /** Server-provided usage guidance, to append to the system prompt. */
  instructions?: string;
  /** Idempotent — safe to call from multiple stream lifecycle hooks. */
  close: () => Promise<void>;
}

/**
 * URL of the platform's org-scoped MCP endpoint, tagged `?context=injected`.
 *
 * The chat injects the get_me payload (`/api/me/context`) straight into its own
 * system prompt, so the server's get_me tool would only re-fetch what the model
 * already has. The tag tells the server to drop that redundant tool (and its
 * "call get_me first" instruction). Both chat engines build their MCP URL
 * through this helper — the ai-sdk client here and the subscription binary's
 * own connection (chat-stream.ts) — so the two never drift.
 */
export function platformMcpUrl(origin: string, orgId: string): string {
  return `${origin}/api/mcp/o/${encodeURIComponent(orgId)}?context=injected`;
}

export async function openPlatformMcp(args: {
  origin: string;
  headers: Record<string, string>;
  /** The MCP endpoint is org-scoped: `/api/mcp/o/:org` (OAuth audience binding). */
  orgId: string;
  /** App context for app-scoped operations (agents, runs); forwarded to dispatch. */
  applicationId?: string;
  fetch?: typeof fetch;
}): Promise<McpHandle> {
  const headers: Record<string, string> = { ...args.headers };
  if (args.applicationId) headers["x-application-id"] = args.applicationId;

  const client = await createMCPClient({
    transport: {
      type: "http",
      url: platformMcpUrl(args.origin, args.orgId),
      headers,
    },
    onUncaughtError: (err) => logger.error("MCP uncaught error", { err: String(err) }),
  });

  // `createMCPClient` has already opened the session; if listing tools fails
  // we must close it or the connection leaks (the caller never gets a handle).
  let tools: ToolSet;
  try {
    tools = await client.tools();
    tools = wrapInvokeOperationTool(tools);
    tools = wrapRunAndWaitTool(tools, {
      origin: args.origin,
      headers,
      fetch: args.fetch ?? fetch,
    });
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await client.close();
    } catch (err) {
      logger.warn("MCP client close failed", { err: String(err) });
    }
  };

  return { tools, instructions: client.instructions, close };
}

function callToolResult(payload: unknown, isError = false): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseLooseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;

  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    // Some tool-call providers hand us an object encoded as a string but leave
    // literal newlines/tabs inside string values. JSON.parse rejects that, while
    // the intended object is still unambiguous enough to recover.
  }

  let repaired = "";
  let inString = false;
  let escaped = false;
  for (const ch of trimmed) {
    if (escaped) {
      repaired += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      repaired += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      repaired += ch;
      continue;
    }
    if (inString && ch === "\n") {
      repaired += "\\n";
      continue;
    }
    if (inString && ch === "\r") {
      repaired += "\\r";
      continue;
    }
    if (inString && ch === "\t") {
      repaired += "\\t";
      continue;
    }
    repaired += ch;
  }

  try {
    return asRecord(JSON.parse(repaired));
  } catch {
    return null;
  }
}

function parseStringifiedJsonObject(text: string): Record<string, unknown> | null {
  try {
    const outer = JSON.parse(text) as unknown;
    if (typeof outer !== "string") return null;
    return parseLooseJsonObject(outer);
  } catch {
    return null;
  }
}

/**
 * Some models occasionally string-encode MCP tool inputs, producing a JSON
 * string whose value is the real object. Repair only that narrow case; schema-
 * invalid objects still fail normally so the model can correct them.
 */
export const repairStringifiedToolCall: ToolCallRepairFunction<AiToolSet> = async ({
  toolCall,
}) => {
  const input =
    parseStringifiedJsonObject(toolCall.input) ??
    (toolCall.toolName === "run_and_wait" ? parseLooseJsonObject(toolCall.input) : null);
  if (!input) return null;
  return { ...toolCall, input: JSON.stringify(input) };
};

function normalizeRunAndWaitArgs(rawArgs: unknown): unknown {
  if (asRecord(rawArgs)) return rawArgs;
  if (typeof rawArgs !== "string") return rawArgs;
  return parseLooseJsonObject(rawArgs) ?? rawArgs;
}

function parseMcpTextResult(output: unknown): Record<string, unknown> | null {
  const content = asRecord(output)?.content;
  if (!Array.isArray(content)) return null;
  const first = asRecord(content[0]);
  const text = first?.type === "text" && typeof first.text === "string" ? first.text : null;
  if (!text) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function compactIntegrationSummary(value: unknown): Record<string, unknown> | null {
  const row = asRecord(value);
  if (!row) return null;
  const manifest = asRecord(row.manifest);
  return {
    id: row.id,
    active: row.active,
    block_user_connections: row.block_user_connections,
    display_name: manifest?.display_name,
    description: manifest?.description,
    default_tools: manifest?.default_tools,
  };
}

function compactListIntegrationsResult(output: unknown): unknown {
  const envelope = parseMcpTextResult(output);
  if (!envelope) return output;

  const body = envelope.body;
  const bodyRecord = asRecord(body);
  const data = Array.isArray(bodyRecord?.data) ? bodyRecord.data : null;
  if (data) {
    const compacted = data.map(compactIntegrationSummary).filter(Boolean);
    return callToolResult({
      status: envelope.status,
      compacted: true,
      object: bodyRecord?.object,
      total: compacted.length,
      data: compacted,
      hasMore: bodyRecord?.hasMore,
      note: "Compacted for chat context. For a specific integration, call getIntegration with path_params.packageId to inspect auths, default_tools, and tool_catalog.",
    });
  }

  if (envelope.truncated || typeof body === "string") {
    return callToolResult({
      status: envelope.status,
      compacted: true,
      truncated: envelope.truncated === true,
      note: "listIntegrations returned a large response omitted from chat context. For a task-specific integration, call getIntegration with the expected @scope/name id, then listIntegrationConnections or initiateIntegrationConnect as needed.",
    });
  }

  return output;
}

export function wrapInvokeOperationTool(tools: ToolSet): ToolSet {
  const invoke = tools.invoke_operation as
    | (Record<string, unknown> & {
        execute?: (args: unknown, options: { abortSignal?: AbortSignal }) => unknown;
      })
    | undefined;
  if (!invoke?.execute) return tools;

  const wrapped = {
    ...invoke,
    async execute(rawArgs: unknown, options: { abortSignal?: AbortSignal }) {
      const output = await invoke.execute!(rawArgs, options);
      const args = asRecord(rawArgs);
      if (args?.operation_id !== "listIntegrations") return output;
      return compactListIntegrationsResult(output);
    },
  };

  const next = { ...tools } as Record<string, unknown>;
  next.invoke_operation = wrapped;
  return next as unknown as ToolSet;
}

export function wrapRunAndWaitTool(
  tools: ToolSet,
  opts: { origin: string; headers: Record<string, string>; fetch: typeof fetch },
): ToolSet {
  const runAndWait = tools.run_and_wait as
    | (Record<string, unknown> & {
        execute?: (args: unknown, options: { abortSignal?: AbortSignal }) => unknown;
      })
    | undefined;
  if (!runAndWait?.execute) return tools;

  const wrapped = {
    ...runAndWait,
    async *execute(rawArgs: unknown, options: { abortSignal?: AbortSignal }) {
      for await (const step of runAndWaitSteps(normalizeRunAndWaitArgs(rawArgs), {
        origin: opts.origin,
        headers: opts.headers,
        fetch: opts.fetch,
        signal: options.abortSignal,
      })) {
        yield callToolResult(step.payload, step.isError);
      }
    },
  };

  const next = { ...tools } as Record<string, unknown>;
  next.run_and_wait = wrapped;
  return next as unknown as ToolSet;
}
