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
 * Try the advertised document, then the path-specific and root well-known locations.
 * A document must name the expected resource (§3.3). If the advertised document
 * is temporarily unavailable and no valid alternative is found, the caller can retry.
 */

import { guardedFetch, SsrfBlockedError } from "@appstrate/core/ssrf";
import { readJsonUnder } from "./bounded-body.ts";
import { sameUrlIdentifier } from "./oauth-discovery.ts";

/** Validated subset of an RFC 9728 protected-resource metadata document. */
export interface ProtectedResourceMetadata {
  /** Canonical resource identifier (RFC 8707 `resource` indicator). */
  resource: string;
  /** Authorization server issuer URLs (RFC 8414 discovery targets). */
  authorizationServers: string[];
  /** `scopes_supported`, when advertised. */
  scopesSupported?: string[];
  /** RFC 9728 §2 human-readable `resource_name`, when advertised. */
  resourceName?: string;
  /** `resource_documentation`, when an http(s) URL. */
  resourceDocumentation?: string;
  /** `resource_policy_uri`, when an http(s) URL. */
  resourcePolicyUri?: string;
}

export interface DiscoverProtectedResourceInput {
  /** The MCP server URL (AFPS `source.remote.url`). */
  resourceServerUrl: string;
  /** Bearer challenge when the caller has already contacted the resource server. */
  challenge?: BearerChallenge;
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

/** Strip a single trailing slash so well-known suffixes join cleanly. */
function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** A well-known metadata location and the resource identifier it was derived from. */
interface MetadataLocation {
  metadataUrl: string;
  resource: string;
}

/** RFC 9728 §3 well-known locations, path-inserted (resource = the URL) then root (its origin). */
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

/** Split the challenge list in one pass, preserving quoted commas and quoted-pairs. */
function* challengeFields(header: string) {
  let start = 0;
  let quoted = false;
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (quoted && c === "\\") i++;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === ",") {
      yield header.slice(start, i);
      start = i + 1;
    }
  }
  if (!quoted) yield header.slice(start);
}

export interface BearerChallenge {
  resourceMetadataUrl?: string;
  scopes?: string[];
}

/** The first Bearer challenge, including only its own RFC 9110 auth-params. */
export function parseBearerChallenge(header: string): BearerChallenge | undefined {
  let bearer: Map<string, string> | undefined;
  for (const part of challengeFields(header)) {
    let field = part.trim();
    if (!field) continue;
    // A leading token followed by '=' is another parameter of the current challenge.
    if (!/^[!#$%&'*+.^_`|~\w-]+\s*=/.test(field)) {
      if (bearer) break;
      const scheme = /^([^\s]+)(?:\s+([\s\S]*))?$/.exec(field);
      if (scheme?.[1]?.toLowerCase() !== "bearer") continue;
      bearer = new Map();
      field = scheme[2] ?? "";
    }
    if (!bearer) continue;
    const param =
      /^([!#$%&'*+.^_`|~\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([!#$%&'*+.^_`|~\w-]+))$/.exec(field);
    if (param) bearer.set(param[1]!.toLowerCase(), param[2]?.replace(/\\(.)/g, "$1") ?? param[3]!);
  }
  if (!bearer) return undefined;
  const resourceMetadataUrl = bearer.get("resource_metadata");
  const scopes = bearer.get("scope")?.split(/\s+/).filter(Boolean);
  return {
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    ...(scopes?.length ? { scopes } : {}),
  };
}

interface RawResourceMetadata {
  resource?: unknown;
  authorization_servers?: unknown;
  scopes_supported?: unknown;
  resource_name?: unknown;
  resource_documentation?: unknown;
  resource_policy_uri?: unknown;
}

/** An http(s) URL string, else `undefined`: these end up as links shown to a user. */
const httpUrlOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" && isHttpUrl(value) ? value : undefined;

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
  const resourceName =
    typeof doc.resource_name === "string" && doc.resource_name.trim() !== ""
      ? doc.resource_name.trim()
      : undefined;
  const resourceDocumentation = httpUrlOrUndefined(doc.resource_documentation);
  const resourcePolicyUri = httpUrlOrUndefined(doc.resource_policy_uri);
  return {
    resource: doc.resource,
    authorizationServers: doc.authorization_servers,
    ...(scopesSupported ? { scopesSupported } : {}),
    ...(resourceName ? { resourceName } : {}),
    ...(resourceDocumentation ? { resourceDocumentation } : {}),
    ...(resourcePolicyUri ? { resourcePolicyUri } : {}),
  };
}

const UNAVAILABLE = Symbol("unavailable");

async function fetchResourceMetadata(
  url: string,
  fetchImpl: typeof fetch,
): Promise<ProtectedResourceMetadata | typeof UNAVAILABLE | null> {
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
    if (res.status === 429 || res.status >= 500) return UNAVAILABLE;
    if (!res.ok) return null;
    const json = await readJsonUnder(res);
    if (!json || typeof json !== "object") return null;
    return validateResourceMetadata(json as RawResourceMetadata);
  } catch (error) {
    return error instanceof SsrfBlockedError && error.reason !== "resolution-failed"
      ? null
      : UNAVAILABLE;
  }
}

/** Discover a valid document and distinguish an advertised server outage from absent metadata. */
export async function discoverProtectedResourceMetadata(
  input: DiscoverProtectedResourceInput,
): Promise<{ metadata: ProtectedResourceMetadata | null; metadataUnreachable?: true }> {
  // Default MUST be the SSRF-guarded fetch, never raw global `fetch`: every URL
  // fetched below is attacker-influencable.
  const fetchImpl = input.fetchImpl ?? (guardedFetch as unknown as typeof fetch);

  // The resource server URL must be http(s); a bogus scheme cannot yield valid
  // metadata and must not reach the network layer.
  if (!isHttpUrl(input.resourceServerUrl)) return { metadata: null };

  let challenge = input.challenge;
  if (!challenge) {
    try {
      const res = await fetchImpl(input.resourceServerUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const header = res.headers.get("www-authenticate");
      if (header) challenge = parseBearerChallenge(header);
    } catch {
      // The well-known locations can still identify the protected resource.
    }
  }

  const advertised = challenge?.resourceMetadataUrl;
  const probes = buildProtectedResourceProbes(input.resourceServerUrl);
  if (advertised) probes.unshift({ metadataUrl: advertised, resource: input.resourceServerUrl });
  // A challenge can advertise a well-known URL. Read it once, checking the resource
  // identifier for each location (the root location can identify the origin).
  const responses = new Map<string, Awaited<ReturnType<typeof fetchResourceMetadata>>>();
  for (const { metadataUrl, resource } of probes) {
    let doc = responses.get(metadataUrl);
    if (doc === undefined) {
      doc = await fetchResourceMetadata(metadataUrl, fetchImpl);
      responses.set(metadataUrl, doc);
    }
    if (doc && doc !== UNAVAILABLE && sameUrlIdentifier(doc.resource, resource))
      return { metadata: doc };
  }
  return {
    metadata: null,
    ...(advertised && responses.get(advertised) === UNAVAILABLE
      ? { metadataUnreachable: true }
      : {}),
  };
}
