// SPDX-License-Identifier: Apache-2.0

/**
 * What the MCP router builds per request, as the unit tests build it: one
 * surface derived from the caller, read by both the tools and the instructions.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateRequestExtra } from "@appstrate/mcp-transport";
import { buildServerInstructions } from "../../../../src/modules/mcp/router.ts";
import {
  buildMcpTools,
  deriveMcpSurface,
  type McpToolContext,
} from "../../../../src/modules/mcp/tools.ts";

/**
 * The tools the router declares for `ctx`'s caller. `proxyAcceptsCredential`: what the router
 * reads off the request's auth method; the contexts built here forward a bearer.
 */
export function toolsFor(ctx: McpToolContext, proxyAcceptsCredential = true) {
  return buildMcpTools(
    ctx,
    deriveMcpSurface(ctx.permissions, ctx.ceiling, ctx.actor, proxyAcceptsCredential),
  );
}

/** The instructions the router serves a user holding `permissions`. */
export function instructionsFor(permissions: Iterable<string>, contextInjected = false): string {
  const set = new Set(permissions);
  return buildServerInstructions(
    set,
    undefined,
    deriveMcpSurface(set, undefined, { type: "user", id: "user_1" }, true),
    contextInjected,
  );
}

/** The handlers that ignore `extra` take this typed placeholder. */
export const noExtra = {} as unknown as AppstrateRequestExtra;

/** The JSON a tool returned as its first text block. */
export function parseResult(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text) as Record<string, unknown>;
}
