// SPDX-License-Identifier: Apache-2.0

/**
 * What the MCP router builds per request, as the unit tests build it: one
 * surface derived from the caller, read by both the tools and the instructions.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateRequestExtra } from "@appstrate/mcp-transport";
import { buildServerInstructions, unionSurface } from "../../../../src/modules/mcp/router.ts";
import type { McpSpace } from "../../../../src/modules/mcp/spaces.ts";
import {
  buildMcpTools,
  deriveMcpSurface,
  type McpToolContext,
} from "../../../../src/modules/mcp/tools.ts";

/**
 * The tools the router declares for `ctx`'s caller. `proxyAcceptsCredential`: what the router
 * reads off the request's auth method; the contexts built here forward a bearer. `proxyOpen`:
 * the space's `credential_proxy_open`.
 */
export function toolsFor(ctx: McpToolContext, proxyAcceptsCredential = true, proxyOpen = true) {
  return buildMcpTools(
    ctx,
    deriveMcpSurface(ctx.permissions, ctx.ceiling, ctx.actor, proxyAcceptsCredential, {
      credentialProxyOpen: proxyOpen,
    }),
  );
}

/** The instructions the router serves a user holding `permissions`. */
export function instructionsFor(permissions: Iterable<string>, rendersCards = false): string {
  const set = new Set(permissions);
  return buildServerInstructions(
    set,
    undefined,
    deriveMcpSurface(set, undefined, { type: "user", id: "user_1" }, true, {
      credentialProxyOpen: true,
    }),
    rendersCards,
  );
}

/** A space of an org-wide connection, its acts derived from `permissions` as the router does. */
export function orgSpace(
  id: string,
  name: string,
  role: string,
  personal: boolean,
  permissions: readonly string[],
): McpSpace {
  const set = new Set(permissions);
  return {
    id,
    name,
    role,
    personal,
    permissions: set,
    surface: deriveMcpSurface(set, undefined, { type: "user", id: "user_1" }, true, {
      credentialProxyOpen: true,
    }),
  };
}

/** The instructions an org-wide connection reaching `spaces` is served (the first is the entered one). */
export function orgWideInstructionsFor(spaces: readonly McpSpace[], rendersCards = false): string {
  const union = new Set(spaces.flatMap((space) => [...space.permissions]));
  return buildServerInstructions(union, undefined, unionSurface(spaces), rendersCards, {
    reachable: spaces,
    current: spaces[0]!,
  });
}

/** The handlers that ignore `extra` take this typed placeholder. */
export const noExtra = {} as unknown as AppstrateRequestExtra;

/** The JSON a tool returned as its first text block. */
export function parseResult(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text) as Record<string, unknown>;
}
