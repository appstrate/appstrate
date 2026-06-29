// SPDX-License-Identifier: Apache-2.0

/**
 * Client to the platform's own MCP server (`/api/mcp`, Streamable HTTP) —
 * ported from the appstrate-chat satellite (lib/appstrate-mcp.ts).
 *
 * The platform exposes its whole REST surface through three progressive tools
 * (`search_operations` / `describe_operation` / `invoke_operation`); we hand
 * them to `streamText` so the model can drive Appstrate — list/run agents,
 * search documents, schedule — with the caller's own permissions. Even
 * in-process we go through `/api/mcp` rather than importing platform
 * internals: the server re-applies auth and RBAC on dispatch, so the chat
 * can never exceed what the caller's credential could do over REST.
 */

import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { logger } from "./logger.ts";

export interface McpHandle {
  /** AI SDK ToolSet, ready for `streamText({ tools })`. */
  tools: Awaited<ReturnType<MCPClient["tools"]>>;
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
  let tools: Awaited<ReturnType<MCPClient["tools"]>>;
  try {
    tools = await client.tools();
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
