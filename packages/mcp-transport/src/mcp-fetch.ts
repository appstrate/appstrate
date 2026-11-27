// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * A `fetch` for an MCP client transport, which calls `fetch(url, init)`. A `Request` input is
 * refused: its method, headers and body are not in the `init` that `send` reads.
 */
export function mcpFetch(
  send: (url: string | URL, init: RequestInit | undefined) => Promise<Response>,
): typeof fetch {
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (input instanceof Request) throw new TypeError("an MCP fetch takes a URL, not a Request");
      return send(input, init);
    },
    // `typeof fetch` (Bun) carries `preconnect`; the transports' `fetch` option demands it.
    { preconnect: fetch.preconnect },
  );
}

/** The methods whose exchange is an MCP operation itself, not its session's handshake or upkeep. */
const OPERATION_METHODS: ReadonlySet<unknown> = new Set(["tools/call", "tools/list"]);

/**
 * Whether a request body is a JSON-RPC request of an operation (`tools/call`, a `tools/list`
 * page): the exchanges a call journal records as one row each.
 */
export function isMcpOperationExchange(body: RequestInit["body"]): boolean {
  if (typeof body !== "string") return false;
  try {
    const message: unknown = JSON.parse(body);
    return (
      typeof message === "object" &&
      message !== null &&
      OPERATION_METHODS.has((message as { method?: unknown }).method)
    );
  } catch {
    return false;
  }
}
