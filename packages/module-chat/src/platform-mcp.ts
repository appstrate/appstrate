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
 * URL of the platform's org-scoped MCP endpoint, tagged `?context=injected`.
 *
 * The chat injects the get_me payload (`/api/me/context`) straight into its own
 * system prompt, so the server's get_me tool would only re-fetch what the model
 * already has. The tag tells the server to drop that redundant tool (and its
 * "call get_me first" instruction).
 */
export function platformMcpUrl(origin: string, orgId: string): string {
  return `${origin}/api/mcp/o/${encodeURIComponent(orgId)}?context=injected`;
}
