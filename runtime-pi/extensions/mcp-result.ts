// SPDX-License-Identifier: Apache-2.0

/**
 * Shared MCP `CallToolResult` → Pi `AgentToolResult` adapter (#276).
 *
 * Both Pi-side surfaces — `mcp-bridge.ts` (the D5.2 alias layer) and
 * `mcp-direct.ts` (the D5.3 native MCP layer) — receive the same MCP
 * `CallToolResult` shape from the sidecar and need to coerce it into
 * the narrower content blocks Pi's tool runtime accepts. Keeping that
 * coercion in one place avoids the silent drift that would happen if
 * one path started honouring a new content type and the other did
 * not. Removing this file means the bug surfaces twice.
 *
 * Pi's `AgentToolResult.content` accepts only `text` and `image`
 * blocks. MCP can also return `resource_link` and inline `resource`
 * blocks; we render those as text pointers ("[resource <uri>]") so
 * the LLM still sees the URI and can request the resource via
 * `resources/read` if it cares.
 */

import type { CallToolResult } from "@appstrate/mcp-transport";

export type PiToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface PiToolResult {
  content: PiToolContent[];
  details: undefined;
}

/**
 * Coerce an MCP `CallToolResult` to Pi's `AgentToolResult` shape.
 * Always returns `details: undefined` — the Pi runtime treats absent
 * details the same as `null`, and we have nothing structured to put
 * there yet.
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
  return { content, details: undefined };
}
