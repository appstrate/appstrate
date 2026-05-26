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
 * Resolve OAuth endpoints, preferring explicit values and falling back to
 * issuer discovery for any that are missing. Best-effort: returns whatever
 * could be resolved (explicit fields are always preserved).
 */
export async function resolveOAuthEndpoints(
  input: ResolveOAuthEndpointsInput,
): Promise<OAuthEndpointResolution> {
  let authorizationEndpoint = input.authorizationEndpoint;
  let tokenEndpoint = input.tokenEndpoint;
  let codeChallengeMethodsSupported: string[] | undefined;
  let userinfoEndpoint: string | undefined;

  // Discovery is also useful when both endpoints are explicit but we still
  // want to learn PKCE-method capability from the IdP — but the historical
  // contract here was "only fetch when an endpoint is missing", so we keep
  // that to avoid an extra network hop on every connect. When the manifest
  // ships explicit endpoints, the caller should also declare the PKCE method
  // list (or accept the S256 default downstream).
  const needsDiscovery = !!input.issuer && (!authorizationEndpoint || !tokenEndpoint);
  if (!needsDiscovery) {
    return { authorizationEndpoint, tokenEndpoint };
  }

  const configuredIssuer = trimTrailingSlash(input.issuer!);
  const candidates = buildDiscoveryProbes(input.issuer!);

  for (const url of candidates) {
    const doc = await fetchDiscoveryDocument(url);
    if (!doc) continue;
    // AFPS §7.3 line 803: validate that the document's `issuer` matches the
    // configured issuer string. Reject + try the next probe on mismatch.
    if (typeof doc.issuer !== "string" || trimTrailingSlash(doc.issuer) !== configuredIssuer) {
      // Discovery is best-effort — log and continue.
      void extractErrorMessage(
        new Error(
          `Discovery issuer mismatch: configured=${configuredIssuer} got=${String(doc.issuer)}`,
        ),
      );
      continue;
    }
    // Manual endpoints win; only fill the gaps from discovery.
    if (!authorizationEndpoint && typeof doc.authorization_endpoint === "string") {
      authorizationEndpoint = doc.authorization_endpoint;
    }
    if (!tokenEndpoint && typeof doc.token_endpoint === "string") {
      tokenEndpoint = doc.token_endpoint;
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
      authorizationEndpoint &&
      tokenEndpoint &&
      codeChallengeMethodsSupported !== undefined &&
      userinfoEndpoint !== undefined
    ) {
      break;
    }
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
