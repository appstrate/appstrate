// SPDX-License-Identifier: Apache-2.0

/** Calling the platform's per-org MCP endpoint (`/api/mcp/o/:org`) from a test. */

export const MCP_ACCEPT = "application/json, text/event-stream";

/** The per-org MCP endpoint for the org the headers' `X-Org-Id` names. */
export function mcpPath(headers: Record<string, string>): string {
  return `/api/mcp/o/${headers["X-Org-Id"]}`;
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
      headers: { ...headers, "content-type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify(message),
    });
    const text = await res.text();
    return { status: res.status, envelope: text ? (JSON.parse(text) as JsonRpcEnvelope) : {} };
  };
}
