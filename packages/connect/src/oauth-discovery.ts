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
 *   - AFPS §7.3 mandates THREE probes in order:
 *       1. RFC 8414 path-insertion:
 *          `${base}/.well-known/oauth-authorization-server${path}`
 *       2. OIDC path-insertion:
 *          `${base}/.well-known/openid-configuration${path}`
 *       3. OIDC path-append:
 *          `${base}${path}/.well-known/openid-configuration`
 *     where `base` is the issuer's origin and `path` is its path component
 *     (empty for root issuers; non-empty for realm-style issuers like
 *     `https://auth.example.com/realms/foo`).
 *   - AFPS §7.3 also REQUIRES validating that the discovery document's
 *     `issuer` member equals the configured issuer string. Documents that
 *     fail this check are rejected and the next probe is tried.
 *   - `code_challenge_methods_supported` (RFC 8414 §2) and `userinfo_endpoint`
 *     (OIDC Discovery 1.0) are projected from the discovery document when
 *     present so callers can derive PKCE behaviour and OIDC userinfo URL from
 *     the IdP's advertised capability. Absent ⇒ undefined (caller picks a
 *     default / falls back to manifest). The manifest's explicit declaration
 *     always wins — discovery is a fallback, not an override.
 */

import { extractErrorMessage } from "./utils.ts";

export interface OAuthEndpointResolution {
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  /**
   * RFC 8414 §2 `code_challenge_methods_supported` as projected from the
   * discovery document. `undefined` when the document does not advertise the
   * field — we never synthesise a default here so callers can distinguish
   * "IdP didn't say" from "IdP said `[]`".
   */
  codeChallengeMethodsSupported?: string[];
  /**
   * OIDC Discovery 1.0 `userinfo_endpoint`. `undefined` when the document
   * omits the field or it isn't a well-formed string URL.
   */
  userinfoEndpoint?: string;
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
 * Build the three probe URLs per AFPS §7.3 from a configured issuer.
 * Exported for tests; callers should use `resolveOAuthEndpoints`.
 */
function buildDiscoveryProbes(issuer: string): string[] {
  // Parse to split origin (base) from path component. Fall back to a flat
  // root-style join if the URL doesn't parse — we still try the two
  // well-known suffixes (and the third probe collapses onto the second).
  let base: string;
  let path: string;
  try {
    const u = new URL(issuer);
    base = `${u.protocol}//${u.host}`;
    // Strip trailing slash from path so we don't produce `//.well-known/…`.
    path = trimTrailingSlash(u.pathname);
    // Treat "/" path as empty for path-insertion semantics.
    if (path === "" || path === "/") path = "";
  } catch {
    const flat = trimTrailingSlash(issuer);
    return [
      `${flat}/.well-known/oauth-authorization-server`,
      `${flat}/.well-known/openid-configuration`,
    ];
  }

  const probes = [
    `${base}/.well-known/oauth-authorization-server${path}`,
    `${base}/.well-known/openid-configuration${path}`,
    `${base}${path}/.well-known/openid-configuration`,
  ];
  // For root issuers (empty path), probes 2 and 3 are identical — dedupe so
  // we don't double-fetch the same URL. Realm-style issuers keep all three.
  return [...new Set(probes)];
}

/**
 * Per-issuer discovery result cache (AFPS §7.3 enrichment).
 *
 * Discovery documents are stable IdP configuration that rotates on the order
 * of weeks/months — we cache the projected fields per issuer URL so a connect
 * burst doesn't hammer the IdP's well-known endpoints. Process-lifetime is
 * the conservative ceiling (no neighbouring TTL cache pattern exists in this
 * package, and tests reset state by reloading the module); operators who need
 * a refresh roll the process. `null` cached entries represent "discovery
 * attempted and failed" so we don't retry on every connect during an outage.
 *
 * Cache is keyed by the trimmed-trailing-slash issuer string — the exact same
 * normalisation used for the §7.3 issuer-equality check below.
 */
interface CachedDiscovery {
  codeChallengeMethodsSupported?: string[];
  userinfoEndpoint?: string;
  /** Discovered endpoints (NOT applied unless manifest leaves them undeclared). */
  discoveredAuthorizationEndpoint?: string;
  discoveredTokenEndpoint?: string;
}
const discoveryCache = new Map<string, CachedDiscovery | null>();

/** Test-only hook so unit tests can run with a clean cache state. */
export function __clearOAuthDiscoveryCache(): void {
  discoveryCache.clear();
}

/**
 * Resolve OAuth endpoints, preferring explicit values and falling back to
 * issuer discovery for any that are missing. Best-effort: returns whatever
 * could be resolved (explicit fields are always preserved).
 *
 * AFPS §7.3 enrichment: when `issuer` is declared, discovery ALWAYS runs (even
 * when both endpoints are manually declared) so we can project the IdP's
 * `userinfo_endpoint` and `code_challenge_methods_supported`. Manual endpoints
 * still win — discovery is enrichment, not override. Results are cached per
 * issuer to amortise the extra well-known fetch.
 */
export async function resolveOAuthEndpoints(
  input: ResolveOAuthEndpointsInput,
): Promise<OAuthEndpointResolution> {
  let authorizationEndpoint = input.authorizationEndpoint;
  let tokenEndpoint = input.tokenEndpoint;
  let codeChallengeMethodsSupported: string[] | undefined;
  let userinfoEndpoint: string | undefined;

  // No issuer — nothing to discover.
  if (!input.issuer) {
    return { authorizationEndpoint, tokenEndpoint };
  }

  const configuredIssuer = trimTrailingSlash(input.issuer);

  // Cache hit — apply enrichment without any network I/O.
  if (discoveryCache.has(configuredIssuer)) {
    const cached = discoveryCache.get(configuredIssuer);
    if (cached) {
      if (!authorizationEndpoint && cached.discoveredAuthorizationEndpoint) {
        authorizationEndpoint = cached.discoveredAuthorizationEndpoint;
      }
      if (!tokenEndpoint && cached.discoveredTokenEndpoint) {
        tokenEndpoint = cached.discoveredTokenEndpoint;
      }
      codeChallengeMethodsSupported = cached.codeChallengeMethodsSupported;
      userinfoEndpoint = cached.userinfoEndpoint;
    }
    return {
      authorizationEndpoint,
      tokenEndpoint,
      ...(codeChallengeMethodsSupported !== undefined ? { codeChallengeMethodsSupported } : {}),
      ...(userinfoEndpoint !== undefined ? { userinfoEndpoint } : {}),
    };
  }

  const candidates = buildDiscoveryProbes(input.issuer);
  let discoveredAuthorizationEndpoint: string | undefined;
  let discoveredTokenEndpoint: string | undefined;

  for (const url of candidates) {
    const doc = await fetchDiscoveryDocument(url);
    if (!doc) continue;
    // AFPS §7.3 line 803: validate that the document's `issuer` matches the
    // configured issuer string. Reject + try the next probe on mismatch.
    // This MUST happen before any field is trusted from the document.
    if (typeof doc.issuer !== "string" || trimTrailingSlash(doc.issuer) !== configuredIssuer) {
      // Discovery is best-effort — log and continue.
      void extractErrorMessage(
        new Error(
          `Discovery issuer mismatch: configured=${configuredIssuer} got=${String(doc.issuer)}`,
        ),
      );
      continue;
    }
    if (
      discoveredAuthorizationEndpoint === undefined &&
      typeof doc.authorization_endpoint === "string"
    ) {
      discoveredAuthorizationEndpoint = doc.authorization_endpoint;
    }
    if (discoveredTokenEndpoint === undefined && typeof doc.token_endpoint === "string") {
      discoveredTokenEndpoint = doc.token_endpoint;
    }
    // RFC 8414 §2 — project the first defined-and-well-shaped array we find.
    // Don't synthesise a default when absent (caller's job).
    if (
      codeChallengeMethodsSupported === undefined &&
      Array.isArray(doc.code_challenge_methods_supported) &&
      doc.code_challenge_methods_supported.every((m): m is string => typeof m === "string")
    ) {
      codeChallengeMethodsSupported = doc.code_challenge_methods_supported;
    }
    // OIDC Discovery 1.0 — project `userinfo_endpoint` when present and
    // well-formed (string URL). Ignore non-string / malformed values.
    if (userinfoEndpoint === undefined && typeof doc.userinfo_endpoint === "string") {
      try {
        // Validate as a URL so callers get a usable string or undefined.
        new URL(doc.userinfo_endpoint);
        userinfoEndpoint = doc.userinfo_endpoint;
      } catch {
        // Malformed — ignore.
      }
    }
    if (
      discoveredAuthorizationEndpoint &&
      discoveredTokenEndpoint &&
      codeChallengeMethodsSupported !== undefined &&
      userinfoEndpoint !== undefined
    ) {
      break;
    }
  }

  // Cache the projection (or null on total failure) so subsequent connects on
  // the same issuer don't re-fetch. A null cache entry still short-circuits
  // — silent fallback to manual values is the spec-mandated behaviour.
  const anyDiscovered =
    discoveredAuthorizationEndpoint !== undefined ||
    discoveredTokenEndpoint !== undefined ||
    codeChallengeMethodsSupported !== undefined ||
    userinfoEndpoint !== undefined;
  discoveryCache.set(
    configuredIssuer,
    anyDiscovered
      ? {
          discoveredAuthorizationEndpoint,
          discoveredTokenEndpoint,
          codeChallengeMethodsSupported,
          userinfoEndpoint,
        }
      : null,
  );

  // Manual endpoints always win — discovery fills only the gaps.
  if (!authorizationEndpoint && discoveredAuthorizationEndpoint) {
    authorizationEndpoint = discoveredAuthorizationEndpoint;
  }
  if (!tokenEndpoint && discoveredTokenEndpoint) {
    tokenEndpoint = discoveredTokenEndpoint;
  }

  return {
    authorizationEndpoint,
    tokenEndpoint,
    ...(codeChallengeMethodsSupported !== undefined ? { codeChallengeMethodsSupported } : {}),
    ...(userinfoEndpoint !== undefined ? { userinfoEndpoint } : {}),
  };
}

interface DiscoveryDocument {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  userinfo_endpoint?: unknown;
  code_challenge_methods_supported?: unknown;
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
