// SPDX-License-Identifier: Apache-2.0

/**
 * Canned OAuth token endpoint for tests that need a *response*, not a
 * *provider*.
 *
 * This server validates nothing: it answers every request with the configured
 * body and status. That makes it right for asserting how the platform handles
 * a given token response (a rotated refresh token, a 401, a scope shrink), and
 * WRONG for asserting that the platform speaks the protocol correctly — a
 * malformed request is accepted here and rejected by a real provider. Exactly
 * that gap let a token exchange carrying an empty `client_secret` pass CI and
 * fail at a customer's consent screen.
 *
 * For anything that exercises the flow itself — client authentication, PKCE,
 * redirect_uri binding, code reuse, whether a refresh token is issued at all —
 * use `strict-oauth-provider.ts`, which enforces the RFCs and refuses
 * non-conformant requests with the same error codes a real provider uses.
 *
 * Uses Bun.serve() on port 0 (random available port).
 */

export interface RecordedRequest {
  method: string;
  path: string;
  body: string;
  headers: Record<string, string>;
}

export interface MockOAuthServer {
  /** Base URL, e.g. "http://localhost:54321" */
  url: string;
  /** Stop the server and free the port. */
  stop: () => void;
  /** All requests received by the server, in order. */
  requests: RecordedRequest[];
  /** Override the JSON body returned by POST /token. */
  setTokenResponse: (response: object) => void;
  /** Override the HTTP status code returned by POST /token. */
  setTokenStatus: (status: number) => void;
  /** Clear recorded requests. */
  clearRequests: () => void;
}

/**
 * Create a mock OAuth provider server.
 *
 * Handles:
 * - POST /token  -- OAuth2 token exchange (configurable response)
 * - GET  /authorize -- OAuth2 authorize endpoint (returns 200 OK for URL validation)
 *
 * All other routes return 404.
 */
export function createMockOAuthServer(): MockOAuthServer {
  let tokenResponse: object = {
    access_token: "mock_access_token_abc123",
    refresh_token: "mock_refresh_token_xyz789",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "read write",
  };
  let tokenStatus = 200;
  const requests: RecordedRequest[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // Record the request
      const body = method !== "GET" ? await req.text() : "";
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key] = value;
      });
      requests.push({ method, path, body, headers });

      // Route handling
      if (method === "POST" && path === "/token") {
        return new Response(JSON.stringify(tokenResponse), {
          status: tokenStatus,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (method === "GET" && path === "/authorize") {
        return new Response("OK", { status: 200 });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(),
    requests,
    setTokenResponse: (response: object) => {
      tokenResponse = response;
    },
    setTokenStatus: (status: number) => {
      tokenStatus = status;
    },
    clearRequests: () => {
      requests.length = 0;
    },
  };
}
