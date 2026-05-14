// SPDX-License-Identifier: Apache-2.0

/**
 * Mock OAuth provider server for integration tests.
 *
 * Uses Bun.serve() on port 0 (random available port) to simulate
 * an external OAuth2 provider's token endpoint.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  body: string;
  headers: Record<string, string>;
}

export interface GrantResponse {
  status: number;
  body: object;
}

export interface MockOAuthServer {
  /** Base URL, e.g. "http://localhost:54321" */
  url: string;
  /** Stop the server and free the port. */
  stop: () => void;
  /** All requests received by the server, in order. */
  requests: RecordedRequest[];
  /** Override the JSON body returned by POST /token (legacy — applies to all grants). */
  setTokenResponse: (response: object) => void;
  /** Override the HTTP status code returned by POST /token (legacy). */
  setTokenStatus: (status: number) => void;
  /**
   * Override the response for a specific `grant_type` body parameter
   * (`password`, `refresh_token`, `authorization_code`). When set, takes
   * priority over the global `setTokenResponse` / `setTokenStatus`
   * fallback. Used by ROPC integration tests to simulate the
   * bootstrap → 401-refresh → invalid_grant → re-bootstrap cycle.
   */
  setGrantResponse: (grantType: string, response: GrantResponse) => void;
  /** Clear all per-grant overrides registered via setGrantResponse. */
  clearGrantResponses: () => void;
  /** Clear recorded requests. */
  clearRequests: () => void;
}

/**
 * Create a mock OAuth provider server.
 *
 * Handles:
 * - POST /token  -- OAuth2 token exchange (configurable response).
 *                   Per-grant-type responses can be configured via
 *                   {@link MockOAuthServer.setGrantResponse} so a single
 *                   server instance can simulate the ROPC bootstrap →
 *                   refresh → invalid_grant → re-bootstrap cycle.
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
  const grantResponses = new Map<string, GrantResponse>();
  const requests: RecordedRequest[] = [];

  function parseGrantType(body: string, contentType: string | undefined): string | undefined {
    try {
      if (contentType?.includes("application/json")) {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        return typeof parsed.grant_type === "string" ? parsed.grant_type : undefined;
      }
      return new URLSearchParams(body).get("grant_type") ?? undefined;
    } catch {
      return undefined;
    }
  }

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
        const grantType = parseGrantType(body, headers["content-type"]);
        const override = grantType ? grantResponses.get(grantType) : undefined;
        if (override) {
          return new Response(JSON.stringify(override.body), {
            status: override.status,
            headers: { "Content-Type": "application/json" },
          });
        }
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
    setGrantResponse: (grantType: string, response: GrantResponse) => {
      grantResponses.set(grantType, response);
    },
    clearGrantResponses: () => {
      grantResponses.clear();
    },
    clearRequests: () => {
      requests.length = 0;
    },
  };
}
