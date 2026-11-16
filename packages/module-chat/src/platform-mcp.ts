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
 * URL of the platform's MCP endpoint, tagged `?context=injected`: pinned to the
 * session's space (`/api/mcp/o/:org/s/:space`, the endpoint's one client-side
 * pin) for a space session, the organization's own (`/api/mcp/o/:org`, where
 * every space-acting tool names its `space_id`) for an organization session
 * (`spaceId` null).
 *
 * The chat injects the get_me payload (`/api/me/context`) straight into its own
 * system prompt, so the server's get_me tool would only re-fetch what the model
 * already has. The tag tells the server to drop that redundant tool (and its
 * "call get_me first" instruction).
 */
export function platformMcpUrl(origin: string, orgId: string, spaceId: string | null): string {
  const organization = `${origin}/api/mcp/o/${encodeURIComponent(orgId)}`;
  return `${spaceId === null ? organization : `${organization}/s/${encodeURIComponent(spaceId)}`}?context=injected`;
}
