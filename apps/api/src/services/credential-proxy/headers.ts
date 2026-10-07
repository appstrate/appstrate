// SPDX-License-Identifier: Apache-2.0

/** Header sets shared by the credential-proxy routes (`/proxy` and `/calls`). */

export const PROXY_CONTROL_HEADERS = new Set([
  "x-integration-id",
  "x-target",
  "x-session-id",
  "x-substitute-body",
  "x-run-id",
  "x-org-id",
  "x-space-id",
  "x-connection-id",
  // Streaming transport hints — consumed by this route, must not reach upstream.
  "x-stream-request",
  "x-stream-response",
  "x-max-response-size",
  "authorization",
  "appstrate-user",
  "appstrate-version",
  // Strip the caller's `accept-encoding` so Bun's upstream fetch picks
  // its own default and auto-decodes transparently — otherwise the
  // caller's list (e.g. `gzip, br, zstd`) can leak through to Gmail,
  // which returns an encoded body that the public route can't safely
  // forward (re-encoding would require rebuffering the whole stream).
  "accept-encoding",
]);

/** Not relayed to the caller: transport hints, and Set-Cookie (a cookie can be the credential). */
export const CALLER_RESPONSE_SKIP_HEADERS = new Set([
  "x-stream-request",
  "x-stream-response",
  "set-cookie",
  "set-cookie2",
]);
