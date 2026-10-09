// SPDX-License-Identifier: Apache-2.0

/** Calling the platform's per-org MCP endpoint (`/api/mcp/o/:org`) from a test. */

export const MCP_ACCEPT = "application/json, text/event-stream";

/**
 * The MCP endpoint for the org the headers' `X-Org-Id` names. A test pins the
 * connection the way a client does, by URL: an `X-Space-Id` in its headers
 * names the space of `/api/mcp/o/:org/s/:space`, and {@link mcpHeaders} drops
 * it from what is sent (the endpoint refuses the header).
 */
export function mcpPath(headers: Record<string, string>): string {
  const space = headers["X-Space-Id"];
  return `/api/mcp/o/${headers["X-Org-Id"]}${space ? `/s/${space}` : ""}`;
}

/** The headers a test sends to the MCP endpoint: its own, less the space {@link mcpPath} moved. */
export function mcpHeaders(headers: Record<string, string>): Record<string, string> {
  const { "X-Space-Id": _inUrl, ...sent } = headers;
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
