// SPDX-License-Identifier: Apache-2.0

/**
 * What the MCP router builds per request, as the unit tests build it: one
 * surface derived from the caller, read by both the tools and the instructions.
 */

import { buildServerInstructions } from "../../../../src/modules/mcp/router.ts";
import {
  buildMcpTools,
  deriveMcpSurface,
  type McpToolContext,
} from "../../../../src/modules/mcp/tools.ts";

/** The tools the router declares for `ctx`'s caller. */
export function toolsFor(ctx: McpToolContext) {
  return buildMcpTools(ctx, deriveMcpSurface(ctx.permissions, ctx.ceiling, ctx.actor));
}

/** The instructions the router serves a user holding `permissions`. */
export function instructionsFor(permissions: Iterable<string>, contextInjected = false): string {
  const set = new Set(permissions);
  return buildServerInstructions(
    set,
    undefined,
    deriveMcpSurface(set, undefined, { type: "user", id: "user_1" }),
    contextInjected,
  );
}
