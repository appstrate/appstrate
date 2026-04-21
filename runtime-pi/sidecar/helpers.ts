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
}

// Import from the dedicated subpath so the compiled sidecar binary does
// NOT pull `@appstrate/connect`'s credentials module (which transitively
// depends on @appstrate/db — unwanted in a credential-isolating proxy).
export {
  substituteVars,
  findUnresolvedPlaceholders,
  HOP_BY_HOP_HEADERS,
  filterHeaders,
} from "@appstrate/connect/proxy-primitives";

// Adapter preserving the sidecar's historical (url, patterns[]) shape.
// Internally delegates to the legacy prefix-star matcher; unifying on
// the AFPS-spec matcher (`matchesAuthorizedUriSpec`) is tracked
// separately — it is a user-visible behaviour change against existing
// provider configs (see proxy-primitives.ts module docstring).
import { matchesAnyAuthorizedUriPrefix } from "@appstrate/connect/proxy-primitives";
export function matchesAuthorizedUri(url: string, patterns: string[]): boolean {
  return matchesAnyAuthorizedUriPrefix(url, patterns);
}
