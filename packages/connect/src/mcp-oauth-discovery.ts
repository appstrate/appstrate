// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 9728 OAuth 2.0 Protected Resource Metadata discovery — the MCP
 * Authorization spec (2025-06-18) onboarding entry point.
 *
 * A remote MCP server is an OAuth 2.0 *protected resource*. Per the MCP spec,
 * an unauthenticated request returns `401` with a
 * `WWW-Authenticate: Bearer ... resource_metadata="<url>"` challenge pointing
 * at the resource's metadata document (RFC 9728). That document advertises:
 *   - `resource`               — the canonical resource identifier, used as the
 *                                RFC 8707 `resource` indicator on the token
 *                                request so the access token is audience-bound.
 *   - `authorization_servers`  — the AS issuer(s) whose RFC 8414 metadata gives
 *                                `authorization_endpoint` / `token_endpoint` /
 *                                `registration_endpoint` (→ auto-DCR).
 *
 * This module resolves that metadata for a given MCP server URL. It is PURE —
 * network I/O only, no DB. The orchestrator (apps/api) chains:
 *   discoverProtectedResourceMetadata → resolveOAuthEndpoints(issuer) →
 *   registerDynamicClient → persist.
 *
 * Resolution order (MCP authorization, RFC 9728 §3 and §5): the caller's explicit
 * `resourceMetadataUrl`, then the `resource_metadata` of a `WWW-Authenticate` challenge to an
 * unauthenticated request, then the path-inserted well-known location, then the root one. A
 * document is used only when its `resource` is identical (modulo a trailing `/`) to the resource
 * identifier its location was derived from (§3.3): the resource URL for an explicit URL, a
 * challenge or the path-inserted location, its origin for the root location. Any other document is
 * skipped, not fatal: the next location is tried.
 *
 * Best-effort throughout: any network/parse/validation failure falls through
 * to the next strategy and ultimately returns `null` (the caller then surfaces
 * the existing "register an OAuth client" error).
 */

import { guardedFetch } from "@appstrate/core/ssrf";

/** Validated subset of an RFC 9728 protected-resource metadata document. */
export interface ProtectedResourceMetadata {
  /** Canonical resource identifier (RFC 8707 `resource` indicator). */
  resource: string;
  /** Authorization server issuer URLs (RFC 8414 discovery targets). */
  authorizationServers: string[];
  /** `scopes_supported`, when advertised. */
  scopesSupported?: string[];
}

export interface DiscoverProtectedResourceInput {
  /** The MCP server URL (AFPS `source.remote.url`). */
  resourceServerUrl: string;
  /**
   * Explicit metadata URL (e.g. the `resource_metadata` value from a
   * `WWW-Authenticate` challenge). Tried first when present.
   */
  resourceMetadataUrl?: string;
  /**
   * Testing seam — defaults to the SSRF-guarded {@link guardedFetch} (per-hop
   * DNS + blocklist, manual redirects, non-http(s) rejection). All metadata /
   * challenge URLs here come from attacker-influencable input (the manifest's
   * `source.remote.url` and the `WWW-Authenticate` challenge the server
   * returns), so the default MUST be guarded — never raw global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

const FETCH_TIMEOUT_MS = 10_000;

/** True for `http:`/`https:` URLs only — rejects `file:`, `gopher:`, etc. */
function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * RFC 9728 §3.3: a metadata document describes the resource identifier its location was derived
 * from, and nothing else. Identical strings once every trailing `/` is stripped (AFPS §7.12's
 * comparison rule); a document for another resource on the same origin must not bind the token's
 * audience.
 */
function resourceIdentifierMatches(resource: string, identifier: string): boolean {
  return stripTrailingSlashes(resource) === stripTrailingSlashes(identifier);
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Strip a single trailing slash so well-known suffixes join cleanly. */
function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** A well-known metadata location and the resource identifier it was derived from. */
interface MetadataLocation {
  metadataUrl: string;
  resource: string;
}

/**
 * RFC 9728 §3 well-known locations for a resource URL, path-inserted first:
 *   `https://host/mcp` → `https://host/.well-known/oauth-protected-resource/mcp` (resource
 *   `https://host/mcp`), then `https://host/.well-known/oauth-protected-resource` (resource
 *   `https://host`). One location for a path-less URL.
 */
export function buildProtectedResourceProbes(resourceServerUrl: string): MetadataLocation[] {
  try {
    const u = new URL(resourceServerUrl);
    const base = `${u.protocol}//${u.host}`;
    let path = trimTrailingSlash(u.pathname);
    if (path === "/" || path === "") path = "";
    const root = { metadataUrl: `${base}/.well-known/oauth-protected-resource`, resource: base };
    return path === ""
      ? [root]
      : [
          {
            metadataUrl: `${base}/.well-known/oauth-protected-resource${path}`,
            resource: resourceServerUrl,
          },
          root,
        ];
  } catch {
    return [];
  }
}

/**
 * Parse the `resource_metadata` parameter out of a `WWW-Authenticate` header
 * value (RFC 9728 §5.1). Returns the URL string or `undefined`.
 */
export function parseResourceMetadataChallenge(wwwAuthenticate: string): string | undefined {
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(wwwAuthenticate);
  return match?.[1];
}

interface RawResourceMetadata {
  resource?: unknown;
  authorization_servers?: unknown;
  scopes_supported?: unknown;
}

/** Coerce a raw JSON document into a validated {@link ProtectedResourceMetadata} or `null`. */
function validateResourceMetadata(
  doc: RawResourceMetadata | null,
): ProtectedResourceMetadata | null {
  if (!doc || typeof doc.resource !== "string") return null;
  if (
    !Array.isArray(doc.authorization_servers) ||
    doc.authorization_servers.length === 0 ||
    !doc.authorization_servers.every((s): s is string => typeof s === "string")
  ) {
    return null;
  }
  const scopesSupported =
    Array.isArray(doc.scopes_supported) &&
    doc.scopes_supported.every((s): s is string => typeof s === "string")
      ? doc.scopes_supported
      : undefined;
  return {
    resource: doc.resource,
    authorizationServers: doc.authorization_servers,
    ...(scopesSupported ? { scopesSupported } : {}),
  };
}

/** Best-effort GET + JSON parse of a metadata URL. Returns `null` on any failure. */
async function fetchResourceMetadata(
  url: string,
  fetchImpl: typeof fetch,
): Promise<ProtectedResourceMetadata | null> {
  // Reject non-http(s) metadata URLs up front (the challenge / well-known value
  // is attacker-influencable). `guardedFetch` also rejects them, but failing
  // here keeps the guarantee independent of the injected `fetchImpl`.
  if (!isHttpUrl(url)) return null;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as unknown;
    if (!json || typeof json !== "object") return null;
    return validateResourceMetadata(json as RawResourceMetadata);
  } catch {
    return null;
  }
}

/**
 * Resolve the protected-resource metadata for an MCP server URL.
 * Returns `null` when no strategy yields a valid document.
 */
export async function discoverProtectedResourceMetadata(
  input: DiscoverProtectedResourceInput,
): Promise<ProtectedResourceMetadata | null> {
  // Default MUST be the SSRF-guarded fetch, never raw global `fetch`: every URL
  // fetched below is attacker-influencable.
  const fetchImpl = input.fetchImpl ?? (guardedFetch as unknown as typeof fetch);

  // The resource server URL must be http(s); a bogus scheme cannot yield valid
  // metadata and must not reach the network layer.
  if (!isHttpUrl(input.resourceServerUrl)) return null;

  const fetchAt = async (
    metadataUrl: string,
    resource: string,
  ): Promise<ProtectedResourceMetadata | null> => {
    const md = await fetchResourceMetadata(metadataUrl, fetchImpl);
    return md && resourceIdentifierMatches(md.resource, resource) ? md : null;
  };

  // 1. Explicit metadata URL (a challenge the caller already holds).
  if (input.resourceMetadataUrl) {
    const md = await fetchAt(input.resourceMetadataUrl, input.resourceServerUrl);
    if (md) return md;
  }

  // 2. The `resource_metadata` challenge of an unauthenticated request (RFC 9728 §5.1).
  try {
    const res = await fetchImpl(input.resourceServerUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const challenge = res.headers.get("www-authenticate");
    const metadataUrl = challenge ? parseResourceMetadataChallenge(challenge) : undefined;
    if (metadataUrl) {
      const md = await fetchAt(metadataUrl, input.resourceServerUrl);
      if (md) return md;
    }
  } catch {
    // Best-effort — fall through to the well-known locations.
  }

  // 3. RFC 9728 §3 well-known locations, path-inserted then root.
  for (const location of buildProtectedResourceProbes(input.resourceServerUrl)) {
    const md = await fetchAt(location.metadataUrl, location.resource);
    if (md) return md;
  }

  return null;
}
