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

export const MAX_RESPONSE_SIZE = 50_000;
export const ABSOLUTE_MAX_RESPONSE_SIZE = 1_000_000; // 1MB
export const OUTBOUND_TIMEOUT_MS = 30_000;
export const MAX_SUBSTITUTE_BODY_SIZE = 5 * 1024 * 1024; // 5MB
export const LLM_PROXY_TIMEOUT_MS = 300_000; // 5 minutes

export type { SidecarConfig, LlmProxyConfig } from "@appstrate/core/sidecar-types";

export interface CredentialsResponse {
  credentials: Record<string, string>;
  authorizedUris: string[] | null;
  allowAllUris: boolean;
  /**
   * Header name the upstream expects the credential under
   * (e.g. `Authorization`, `X-Api-Key`). When present, the sidecar
   * writes the final header server-side from
   * `credentials[credentialFieldName]` — the LLM never touches the
   * credential value. Absent = no header injection (basic/custom auth
   * modes, or providers that pass credentials via URL / query / body).
   */
  credentialHeaderName?: string;
  /**
   * Optional prefix prepended to the credential value (e.g. `Bearer`).
   * Rendered as `${prefix} ${credentials[credentialFieldName]}`.
   */
  credentialHeaderPrefix?: string;
  /**
   * Name of the field in `credentials` holding the secret to inject.
   * Always populated by the platform (defaults by auth mode).
   */
  credentialFieldName: string;
}

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
 * matches any substring). Thin wrapper preserving the sidecar's
 * historical `(url, patterns[])` shape.
 */
export function matchesAuthorizedUri(url: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesAuthorizedUriSpec(p, url));
}
