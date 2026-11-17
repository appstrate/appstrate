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
 * URL of the organization's MCP endpoint (`/api/mcp/o/:org`, where every space-acting tool
 * names its `space_id`; the turn's bearer allowlists the spaces it may name — a limited
 * conversation's origin alone), tagged `?renders_cards=true`.
 *
 * The tag tells the server this client renders connect offers and run cards itself and resumes an
 * unfinished run on a later turn, so its instructions say so; the tools are the same as any
 * client's.
 */
export function platformMcpUrl(origin: string, orgId: string): string {
  return `${origin}/api/mcp/o/${encodeURIComponent(orgId)}?renders_cards=true`;
}
