// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery-first OAuth endpoint resolution (RFC 8414 / OIDC Discovery 1.0).
 *
 * AFPS 2.0 lets an `oauth2` auth declare an `issuer` instead of (or alongside)
 * explicit `authorization_endpoint` / `token_endpoint`. When an issuer is
 * present and an endpoint is missing, we fetch the issuer's discovery document
 * and fill the gaps.
 *
 * Resolution rules:
 *   - Manual endpoints ALWAYS override discovered ones — an explicit
 *     `authorization_endpoint`/`token_endpoint` is authoritative.
 *   - Discovery is best-effort: a network/parse failure is swallowed and the
 *     manual endpoints (if any) are returned unchanged. The caller decides
 *     whether the resulting (possibly partial) resolution is sufficient.
 *   - We probe the OIDC well-known path first
 *     (`${issuer}/.well-known/openid-configuration`), then the RFC 8414
 *     OAuth metadata path (`${issuer}/.well-known/oauth-authorization-server`).
 */

import { extractErrorMessage } from "./utils.ts";

export interface OAuthEndpointResolution {
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
}

export interface ResolveOAuthEndpointsInput {
  /** Issuer URL (RFC 8414 / OIDC). Discovery is skipped when absent. */
  issuer?: string;
  /** Explicit authorization endpoint — wins over discovery when present. */
  authorizationEndpoint?: string;
  /** Explicit token endpoint — wins over discovery when present. */
  tokenEndpoint?: string;
}

/** Strip a single trailing slash so well-known suffixes join cleanly. */
function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Resolve OAuth endpoints, preferring explicit values and falling back to
 * issuer discovery for any that are missing. Best-effort: returns whatever
 * could be resolved (explicit fields are always preserved).
 */
export async function resolveOAuthEndpoints(
  input: ResolveOAuthEndpointsInput,
): Promise<OAuthEndpointResolution> {
  let authorizationEndpoint = input.authorizationEndpoint;
  let tokenEndpoint = input.tokenEndpoint;

  // Only discover when there is something to discover and a gap to fill.
  const needsDiscovery = !!input.issuer && (!authorizationEndpoint || !tokenEndpoint);
  if (!needsDiscovery) {
    return { authorizationEndpoint, tokenEndpoint };
  }

  const base = trimTrailingSlash(input.issuer!);
  const candidates = [
    `${base}/.well-known/openid-configuration`,
    `${base}/.well-known/oauth-authorization-server`,
  ];

  for (const url of candidates) {
    const doc = await fetchDiscoveryDocument(url);
    if (!doc) continue;
    // Manual endpoints win; only fill the gaps from discovery.
    if (!authorizationEndpoint && typeof doc.authorization_endpoint === "string") {
      authorizationEndpoint = doc.authorization_endpoint;
    }
    if (!tokenEndpoint && typeof doc.token_endpoint === "string") {
      tokenEndpoint = doc.token_endpoint;
    }
    if (authorizationEndpoint && tokenEndpoint) break;
  }

  return { authorizationEndpoint, tokenEndpoint };
}

interface DiscoveryDocument {
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
}

/** Best-effort fetch + parse of a discovery document. Returns `null` on any failure. */
async function fetchDiscoveryDocument(url: string): Promise<DiscoveryDocument | null> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as unknown;
    if (!json || typeof json !== "object") return null;
    return json as DiscoveryDocument;
  } catch (err) {
    // Best-effort: discovery failures fall back to manual endpoints. Swallow.
    void extractErrorMessage(err);
    return null;
  }
}
