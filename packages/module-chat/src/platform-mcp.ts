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
 * URL of the platform's MCP endpoint, tagged `?context=injected`: the organization's own
 * (`/api/mcp/o/:org`, where every space-acting tool names its `space_id`), or, for a
 * limited conversation (`spaceId`), the endpoint pinned to its origin space
 * (`/api/mcp/o/:org/s/:space`, the endpoint's one client-side pin).
 *
 * The tag tells the server this client renders connect offers and run cards itself and resumes an
 * unfinished run on a later turn, so its instructions say so; the tools are the same as any
 * client's, `get_me` included.
 */
export function platformMcpUrl(origin: string, orgId: string, spaceId?: string): string {
  const organization = `${origin}/api/mcp/o/${encodeURIComponent(orgId)}`;
  return `${spaceId === undefined ? organization : `${organization}/s/${encodeURIComponent(spaceId)}`}?context=injected`;
}
