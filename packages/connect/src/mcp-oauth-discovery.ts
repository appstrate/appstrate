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
 * Resolution order (first hit wins):
 *   1. Explicit `resourceMetadataUrl` (e.g. parsed from a WWW-Authenticate
 *      challenge the caller already has) — authoritative.
 *   2. RFC 9728 §3 well-known probes derived from the resource URL.
 *   3. Best-effort `401` probe of the resource URL itself, parsing the
 *      `resource_metadata` challenge param, then fetching that.
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
 * RFC 9728 §3.3: the `resource` value in a protected-resource metadata document
 * MUST identify the resource server the client is talking to. Validate that its
 * origin matches the MCP server URL we discovered it for — otherwise a hostile
 * (or misconfigured) metadata document could bind the token's audience to an
 * unrelated resource. Compared by origin (scheme+host+port) to tolerate path /
 * trailing-slash differences in the canonical identifier.
 */
function metadataResourceMatchesOrigin(resource: string, resourceServerUrl: string): boolean {
  try {
    return new URL(resource).origin === new URL(resourceServerUrl).origin;
  } catch {
    return false;
  }
}

/** Strip a single trailing slash so well-known suffixes join cleanly. */
function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Build RFC 9728 §3 well-known probe URLs for a resource server URL. The
 * well-known segment is inserted between the host and the path component:
 *   `https://host/mcp` → `https://host/.well-known/oauth-protected-resource/mcp`
 * The path-less variant is always included as a fallback.
 */
export function buildProtectedResourceProbes(resourceServerUrl: string): string[] {
  try {
    const u = new URL(resourceServerUrl);
    const base = `${u.protocol}//${u.host}`;
    let path = trimTrailingSlash(u.pathname);
    if (path === "/" || path === "") path = "";
    const probes = [
      `${base}/.well-known/oauth-protected-resource${path}`,
      `${base}/.well-known/oauth-protected-resource`,
    ];
    return [...new Set(probes)];
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

  // Any resolved document is only accepted when its RFC 8707 `resource`
  // identifier matches the MCP server's origin (RFC 9728 §3.3).
  const accept = (md: ProtectedResourceMetadata | null): ProtectedResourceMetadata | null =>
    md && metadataResourceMatchesOrigin(md.resource, input.resourceServerUrl) ? md : null;

  // 1. Explicit metadata URL (authoritative).
  if (input.resourceMetadataUrl) {
    const md = accept(await fetchResourceMetadata(input.resourceMetadataUrl, fetchImpl));
    if (md) return md;
  }

  // 2. RFC 9728 §3 well-known probes.
  for (const url of buildProtectedResourceProbes(input.resourceServerUrl)) {
    const md = accept(await fetchResourceMetadata(url, fetchImpl));
    if (md) return md;
  }

  // 3. Best-effort 401 probe — read the `resource_metadata` challenge the
  //    server advertises on an unauthenticated request, then fetch it.
  try {
    const res = await fetchImpl(input.resourceServerUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const challenge = res.headers.get("www-authenticate");
    if (challenge) {
      const metadataUrl = parseResourceMetadataChallenge(challenge);
      if (metadataUrl) {
        const md = accept(await fetchResourceMetadata(metadataUrl, fetchImpl));
        if (md) return md;
      }
    }
  } catch {
    // Best-effort — fall through to null.
  }

  return null;
}
