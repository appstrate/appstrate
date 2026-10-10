// SPDX-License-Identifier: Apache-2.0

/** Calling the platform's per-org MCP endpoint (`/api/mcp/o/:org`) from a test. */

import { orgOnlyHeaders, type TestContext } from "./auth.ts";

export const MCP_ACCEPT = "application/json, text/event-stream";

/**
 * Pseudo-key a test's headers use to name the space of the URL
 * (`/api/mcp/o/:org/s/:space`) — not a header name, so it can never reach the
 * wire. Set it with {@link inSpace}.
 */
const MCP_SPACE = "mcp:space";

/** A session caller's MCP headers, pinned by URL to the context's default space. */
export function mcpAuthHeaders(ctx: TestContext): Record<string, string> {
  return inSpace(orgOnlyHeaders(ctx), ctx.defaultSpaceId);
}

/** `headers` for a connection pinned by URL to `spaceId`. */
export function inSpace(headers: Record<string, string>, spaceId: string): Record<string, string> {
  return { ...headers, [MCP_SPACE]: spaceId };
}

/** The MCP endpoint for the org the headers' `X-Org-Id` names, pinned to their space if any. */
export function mcpPath(headers: Record<string, string>): string {
  const space = headers[MCP_SPACE];
  return `/api/mcp/o/${headers["X-Org-Id"]}${space ? `/s/${space}` : ""}`;
}

/** The headers a test sends to the MCP endpoint: its own, less the URL's space. */
export function mcpHeaders(headers: Record<string, string>): Record<string, string> {
  const { [MCP_SPACE]: _inUrl, ...sent } = headers;
  return sent;
}

export interface JsonRpcEnvelope {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface RequestTarget {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

/** POST a JSON-RPC message to the caller's per-org endpoint on `app`, parse the envelope. */
export function mcpRpc(app: RequestTarget) {
  return async (
    headers: Record<string, string>,
    message: Record<string, unknown>,
    requestOrigin = "",
  ): Promise<{ status: number; envelope: JsonRpcEnvelope }> => {
    const res = await app.request(`${requestOrigin}${mcpPath(headers)}`, {
      method: "POST",
      headers: { ...mcpHeaders(headers), "content-type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify(message),
    });
    const text = await res.text();
    return { status: res.status, envelope: text ? (JSON.parse(text) as JsonRpcEnvelope) : {} };
  };
}

/** The JSON-RPC messages an SSE response body carries, one per `data:` event, in order. */
export function sseMessages(text: string): Array<JsonRpcEnvelope & { method?: string }> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice("data:".length)) as JsonRpcEnvelope & { method?: string });
}
