// SPDX-License-Identifier: Apache-2.0

/**
 * The control headers of `/api/credential-proxy/proxy`, lower case. The route consumes them and
 * never sends one upstream; the MCP `api_call` tool sets them from typed arguments and lets no
 * free-form header carry one. `X-Run-Id` is among the platform's own request headers
 * (`isPlatformRequestHeader`, `@appstrate/connect/platform-request-headers`).
 */
export const PROXY_CONTROL_HEADERS: ReadonlySet<string> = new Set([
  "x-integration-id",
  "x-target",
  "x-session-id",
  "x-connection-id",
  "x-substitute-body",
  "x-stream-request",
  "x-stream-response",
  "x-max-response-size",
]);
