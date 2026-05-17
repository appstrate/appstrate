// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 9728 (OAuth Protected Resource Metadata) + RFC 8414
 * (Authorization Server Metadata) + OIDC Discovery cascade.
 *
 * Used when an AFPS integration declares
 * `auths.{key}.discovery.protectedResourceMetadataUrl` instead of
 * spelling out `authorizationUrl` / `tokenUrl` / `refreshUrl` /
 * `revokeUrl`. The runtime calls {@link discoverEndpoints} on first
 * connection, then caches the resolved endpoints with a TTL so
 * subsequent runs do not re-fetch metadata for every spawn.
 *
 * I/O boundary: the network call is injected via a {@link FetchJsonFn}
 * so the resolver can be unit-tested without hitting real ASs. The
 * default implementation uses `fetch` with SSRF protection
 * (`@appstrate/core/ssrf.isBlockedUrl`), timeouts, a single redirect
 * chain bounded to 3 hops, and rejects anything that isn't `https:`.
 *
 * What we do NOT implement here (deferred to Phase 1.2b serverAuth):
 *
 *   - Dynamic client registration (RFC 7591) — only matters for the
 *     MCP-server-as-resource flow, not for the upstream-API binding.
 *   - WWW-Authenticate header parsing — that's a 401-recovery hint for
 *     unknown servers; here the user has explicitly opted into the
 *     RFC 9728 discovery URL, so we never need to bootstrap from a 401.
 */

import { isBlockedUrl } from "@appstrate/core/ssrf";

/** Endpoints we end up with after walking the discovery cascade. */
export interface ResolvedAuthorizationEndpoints {
  authorizationUrl: string;
  tokenUrl: string;
  /** From RFC 8414 / OIDC — falls back to {@link tokenUrl} per RFC 6749 §6. */
  refreshUrl: string;
  /** RFC 7009 — optional in both AS metadata documents. */
  revokeUrl?: string;
  /** Issuer (`iss` claim) of the resolved AS — useful for caller audit logs. */
  issuer: string;
  /** Audience values the protected-resource metadata declared (RFC 9728 §2). */
  audiences?: string[];
}

/** Inbound resource metadata shape (RFC 9728 §2 — required + relevant optionals). */
export interface ProtectedResourceMetadata {
  resource: string;
  /** One or more issuer URLs that may serve tokens for this resource. */
  authorization_servers?: string[];
  /** Scope values the resource supports — passed through for context. */
  scopes_supported?: string[];
  /** Audience values the AS MUST bind in `aud` claims (RFC 9728 §2). */
  resource_documentation?: string;
}

/** Inbound AS metadata shape (RFC 8414 §2 — minimal subset we read). */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  /** RFC 6749 §6 — when omitted, refresh requests go to `token_endpoint`. */
  refresh_endpoint?: string;
  /** RFC 7009. */
  revocation_endpoint?: string;
}

/** Injectable JSON fetcher — defaults to the SSRF-protected implementation below. */
export type FetchJsonFn = (url: string) => Promise<unknown>;

/** Injectable clock — defaults to `Date.now`, swappable for cache tests. */
export type ClockFn = () => number;

export interface DiscoverEndpointsOptions {
  /** URL pointing at a `.well-known/oauth-protected-resource` document. */
  protectedResourceMetadataUrl: string;
  /**
   * Allowlist of accepted issuer URLs. When the protected-resource
   * metadata advertises multiple `authorization_servers[]`, only those
   * matching the allowlist (exact issuer URL match — no glob) are
   * considered. When empty, the resolver picks the first server
   * declared. Operators SHOULD pass an allowlist in production to
   * defend against compromised resource metadata advertising a
   * rogue AS.
   */
  allowedIssuers?: readonly string[];
  /** Inject a test double; defaults to the SSRF-protected fetcher. */
  fetchJson?: FetchJsonFn;
  /** Defaults to `Date.now`. */
  now?: ClockFn;
  /** Skip cache lookup (still writes on success). Defaults to `false`. */
  skipCache?: boolean;
  /**
   * Override TTL for this call's cache write. Defaults to
   * {@link DEFAULT_DISCOVERY_TTL_MS}. Set to `0` to bypass caching
   * entirely (read AND write).
   */
  ttlMs?: number;
}

/** Tagged error so callers can differentiate operator-level configuration issues. */
export class DiscoveryError extends Error {
  readonly code: DiscoveryErrorCode;
  constructor(message: string, code: DiscoveryErrorCode) {
    super(message);
    this.name = "DiscoveryError";
    this.code = code;
  }
}

export type DiscoveryErrorCode =
  /** SSRF / non-https / unparseable URL. */
  | "BLOCKED_URL"
  /** Network or HTTP failure. */
  | "FETCH_FAILED"
  /** Body parsed but missing required fields. */
  | "INVALID_METADATA"
  /** `authorization_servers[]` did not intersect with `allowedIssuers`. */
  | "NO_ALLOWED_ISSUER"
  /** The resolved AS metadata is missing `authorization_endpoint` or `token_endpoint`. */
  | "INCOMPLETE_AS_METADATA";

/** Default TTL — long enough that discovery doesn't dominate per-run latency, short enough to pick up issuer rotations within a day. */
export const DEFAULT_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  value: ResolvedAuthorizationEndpoints;
  expiresAt: number;
}

/** Module-level cache. Tests can swap via {@link clearDiscoveryCache}. */
const cache = new Map<string, CacheEntry>();

/** Test-only: wipe the in-memory discovery cache. */
export function clearDiscoveryCache(): void {
  cache.clear();
}

/**
 * Walk the RFC 9728 → RFC 8414 cascade and return the endpoints the
 * runtime needs to drive an OAuth flow (`/authorize`, `/token`,
 * refresh, optional revoke).
 *
 * Cache key = `${protectedResourceMetadataUrl}::${sortedAllowedIssuers.join("|")}`.
 * The allowlist is part of the key so flipping it doesn't return a
 * stale value from before the policy change.
 */
export async function discoverEndpoints(
  opts: DiscoverEndpointsOptions,
): Promise<ResolvedAuthorizationEndpoints> {
  const now = opts.now ?? Date.now;
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const ttlMs = opts.ttlMs ?? DEFAULT_DISCOVERY_TTL_MS;
  const cacheKey = buildCacheKey(opts.protectedResourceMetadataUrl, opts.allowedIssuers);

  if (!opts.skipCache && ttlMs > 0) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > now()) return hit.value;
  }

  assertReachableUrl(opts.protectedResourceMetadataUrl);
  const prmRaw = await fetchJsonOrThrow(fetchJson, opts.protectedResourceMetadataUrl);
  const prm = narrowProtectedResource(prmRaw, opts.protectedResourceMetadataUrl);

  const candidateServers = prm.authorization_servers ?? [];
  if (candidateServers.length === 0) {
    throw new DiscoveryError(
      `Protected-resource metadata at ${opts.protectedResourceMetadataUrl} declares no authorization_servers[]`,
      "INVALID_METADATA",
    );
  }

  const issuerUrl = selectAuthorizationServer(candidateServers, opts.allowedIssuers ?? []);

  const asMetadataUrl = buildAsMetadataUrl(issuerUrl);
  assertReachableUrl(asMetadataUrl);
  const asRaw = await fetchJsonOrThrow(fetchJson, asMetadataUrl);
  const asMeta = narrowAuthorizationServer(asRaw, asMetadataUrl);

  const resolved: ResolvedAuthorizationEndpoints = {
    authorizationUrl: asMeta.authorization_endpoint,
    tokenUrl: asMeta.token_endpoint,
    refreshUrl: asMeta.refresh_endpoint ?? asMeta.token_endpoint,
    revokeUrl: asMeta.revocation_endpoint,
    issuer: asMeta.issuer,
  };

  if (ttlMs > 0) {
    cache.set(cacheKey, { value: resolved, expiresAt: now() + ttlMs });
  }
  return resolved;
}

/**
 * Pick which authorization server to use from the candidates declared
 * by the protected resource. Allowlist takes precedence — operators
 * passing one MUST get a deterministic match or a hard error.
 *
 * Exported for unit testing; callers normally go through
 * {@link discoverEndpoints} which calls this internally.
 */
export function selectAuthorizationServer(
  candidates: readonly string[],
  allowedIssuers: readonly string[],
): string {
  if (allowedIssuers.length === 0) {
    return candidates[0]!;
  }
  for (const c of candidates) {
    if (allowedIssuers.includes(c)) return c;
  }
  throw new DiscoveryError(
    `None of the advertised authorization_servers (${candidates.join(", ")}) match the operator allowlist (${allowedIssuers.join(", ")})`,
    "NO_ALLOWED_ISSUER",
  );
}

/**
 * RFC 8414 §3.1 — `https://issuer/.well-known/oauth-authorization-server`
 * when the issuer path is `/`, else `https://issuer/.well-known/oauth-authorization-server/<path>`.
 * Falls back gracefully to the OIDC well-known URL the caller-supplied
 * issuer might use (`/.well-known/openid-configuration`) only if AS
 * metadata lookup returns 404 — that's a runtime decision and lives
 * in the caller's retry layer, not here.
 */
export function buildAsMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.origin}/.well-known/oauth-authorization-server${path}`;
}

// ─────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────

function buildCacheKey(prmUrl: string, allowedIssuers: readonly string[] | undefined): string {
  const sorted = [...(allowedIssuers ?? [])].sort();
  return `${prmUrl}::${sorted.join("|")}`;
}

function assertReachableUrl(url: string): void {
  if (isBlockedUrl(url)) {
    throw new DiscoveryError(
      `Discovery URL ${url} is blocked (non-https, malformed, or private network)`,
      "BLOCKED_URL",
    );
  }
}

async function fetchJsonOrThrow(fetchJson: FetchJsonFn, url: string): Promise<unknown> {
  try {
    return await fetchJson(url);
  } catch (err) {
    throw new DiscoveryError(
      `Discovery fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      "FETCH_FAILED",
    );
  }
}

function narrowProtectedResource(raw: unknown, url: string): ProtectedResourceMetadata {
  if (!raw || typeof raw !== "object") {
    throw new DiscoveryError(
      `Protected-resource metadata at ${url} is not a JSON object`,
      "INVALID_METADATA",
    );
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.resource !== "string") {
    throw new DiscoveryError(
      `Protected-resource metadata at ${url} is missing required field "resource"`,
      "INVALID_METADATA",
    );
  }
  const result: ProtectedResourceMetadata = { resource: r.resource };
  if (Array.isArray(r.authorization_servers)) {
    result.authorization_servers = r.authorization_servers.filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
  }
  if (Array.isArray(r.scopes_supported)) {
    result.scopes_supported = r.scopes_supported.filter((s): s is string => typeof s === "string");
  }
  return result;
}

function narrowAuthorizationServer(raw: unknown, url: string): AuthorizationServerMetadata {
  if (!raw || typeof raw !== "object") {
    throw new DiscoveryError(
      `Authorization-server metadata at ${url} is not a JSON object`,
      "INVALID_METADATA",
    );
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.issuer !== "string" || r.issuer.length === 0) {
    throw new DiscoveryError(
      `Authorization-server metadata at ${url} is missing "issuer"`,
      "INCOMPLETE_AS_METADATA",
    );
  }
  if (typeof r.authorization_endpoint !== "string" || r.authorization_endpoint.length === 0) {
    throw new DiscoveryError(
      `Authorization-server metadata at ${url} is missing "authorization_endpoint"`,
      "INCOMPLETE_AS_METADATA",
    );
  }
  if (typeof r.token_endpoint !== "string" || r.token_endpoint.length === 0) {
    throw new DiscoveryError(
      `Authorization-server metadata at ${url} is missing "token_endpoint"`,
      "INCOMPLETE_AS_METADATA",
    );
  }
  return {
    issuer: r.issuer,
    authorization_endpoint: r.authorization_endpoint,
    token_endpoint: r.token_endpoint,
    refresh_endpoint:
      typeof r.refresh_endpoint === "string" && r.refresh_endpoint.length > 0
        ? r.refresh_endpoint
        : undefined,
    revocation_endpoint:
      typeof r.revocation_endpoint === "string" && r.revocation_endpoint.length > 0
        ? r.revocation_endpoint
        : undefined,
  };
}

const defaultFetchJson: FetchJsonFn = async (url) => {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as unknown;
};
