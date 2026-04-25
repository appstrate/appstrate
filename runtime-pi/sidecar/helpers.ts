// SPDX-License-Identifier: Apache-2.0

/**
 * Sidecar-local constants + thin re-exports over `@appstrate/connect`
 * shared credential-proxy primitives. The shared module is the single
 * source of truth so any improvement (placeholder semantics, URL
 * allowlist matching, hop-by-hop header list) propagates to both the
 * public `/api/credential-proxy/proxy` route and this in-container
 * sidecar automatically.
 */

export { isBlockedHost, isBlockedUrl } from "./ssrf.ts";

// Accepts both simple IDs (gmail) and scoped IDs (@appstrate/gmail)
export const PROVIDER_ID_RE = /^(@[a-z0-9][a-z0-9-]*\/)?[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// Default cap on upstream response bytes the sidecar buffers before
// returning them inline. Set generously enough that typical provider
// responses (Drive metadata listings, Gmail thread snippets, paginated
// payloads) round-trip untruncated. Larger or binary responses spill
// to the run-scoped BlobStore and surface as MCP `resource_link`
// blocks; the absolute ceiling is `ABSOLUTE_MAX_RESPONSE_SIZE`.
export const MAX_RESPONSE_SIZE = 256 * 1024; // 256 KB
export const ABSOLUTE_MAX_RESPONSE_SIZE = 1_000_000; // 1MB — hard cap, even when X-Max-Response-Size is larger
export const OUTBOUND_TIMEOUT_MS = 30_000;
export const MAX_SUBSTITUTE_BODY_SIZE = 5 * 1024 * 1024; // 5MB
export const LLM_PROXY_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Below this size, request bodies are buffered in memory so that the
 * 401-refresh-and-retry-once path can replay them with rotated
 * credentials. Above it, the sidecar streams the body upstream via
 * `duplex: "half"` and surfaces 401 to the caller (the AFPS resolver's
 * `{ fromFile }` resolution is reproducible — the LLM-driven retry
 * path will refresh credentials and re-call cleanly).
 */
export const STREAMING_THRESHOLD = 1 * 1024 * 1024; // 1 MB

/**
 * Hard ceiling on streamed request/response bodies. Above this the
 * sidecar refuses with 413 even when the caller opts into streaming
 * via `responseMode` or a `Content-Length` over
 * {@link STREAMING_THRESHOLD}. Provides a safety bound for memory
 * pressure regardless of streaming.
 */
export const MAX_STREAMED_BODY_SIZE = 100 * 1024 * 1024; // 100 MB

export type { SidecarConfig, LlmProxyConfig } from "@appstrate/core/sidecar-types";

// The credentials payload the sidecar receives over HTTP is
// wire-identical to what the platform's `/api/credential-proxy/proxy`
// route resolves from the DB — both are `ProxyCredentialsPayload`. The
// local alias keeps call sites readable (this is the HTTP response
// body from `/internal/providers/credentials`).
export type { ProxyCredentialsPayload as CredentialsResponse } from "@appstrate/connect/proxy-primitives";

// Import from the dedicated subpath so the compiled sidecar binary does
// NOT pull `@appstrate/connect`'s credentials module (which transitively
// depends on @appstrate/db — unwanted in a credential-isolating proxy).
export {
  substituteVars,
  findUnresolvedPlaceholders,
  HOP_BY_HOP_HEADERS,
  filterHeaders,
  buildInjectedCredentialHeader,
  applyInjectedCredentialHeader,
  normalizeAuthScheme,
} from "@appstrate/connect/proxy-primitives";

import { matchesAuthorizedUriSpec } from "@appstrate/connect/proxy-primitives";

/**
 * Check a target URL against a list of `authorizedUris` patterns using
 * the AFPS 1.3 spec semantics (`*` matches a single path segment, `**`
 * matches any substring). Thin wrapper exposing a `(url, patterns[])`
 * call shape.
 */
export function matchesAuthorizedUri(url: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesAuthorizedUriSpec(p, url));
}
