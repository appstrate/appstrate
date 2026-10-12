// SPDX-License-Identifier: Apache-2.0

/**
 * The control headers of `/api/credential-proxy/proxy`: what the call is made with (integration,
 * connection, target, session) and how its body travels. The route consumes them and never sends
 * one upstream; a caller that builds the request from typed arguments sets them itself and lets no
 * free-form header carry one. Lower case, as `Headers` yields names. The headers of the platform's
 * own request (`X-Run-Id` among them) are `isPlatformRequestHeader`'s
 * (`@appstrate/connect/platform-request-headers`), not repeated here.
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
