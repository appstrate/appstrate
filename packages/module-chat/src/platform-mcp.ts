// SPDX-License-Identifier: Apache-2.0

/**
 * Where the chat's own MCP client points.
 *
 * The platform exposes its REST surface through progressive MCP tools
 * (`search_operations` / `describe_operation` / `invoke_operation`) plus the
 * run-specific `run_and_wait` shortcut, so the model can drive Appstrate with
 * the caller's own permissions. The chat engine opens that connection itself
 * (`pi-chat/mcp-tools.ts`); this module only owns the URL both sides must agree
 * on.
 */

/**
 * URL of the platform's MCP endpoint pinned to the session's space
 * (`/api/mcp/o/:org/s/:space`, the endpoint's one client-side pin), tagged
 * `?context=injected`.
 *
 * The tag tells the server this client is the chat: it renders a connect offer
 * as a card of its own and gets `done:false` at the end of its turn budget, so
 * the server's instructions word those cases for it. It changes no tool: the
 * chat keeps `get_me`, which is where it learns the caller's connections and
 * runnable agents.
 */
export function platformMcpUrl(origin: string, orgId: string, spaceId: string): string {
  return `${origin}/api/mcp/o/${encodeURIComponent(orgId)}/s/${encodeURIComponent(spaceId)}?context=injected`;
}
