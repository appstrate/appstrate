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
