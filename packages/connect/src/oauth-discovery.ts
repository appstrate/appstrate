// SPDX-License-Identifier: Apache-2.0

import { createCache } from "@appstrate/core/cache";
import { readJsonUnder } from "./bounded-body.ts";
import { oauthEgressFetch } from "./oauth-egress.ts";

/**
 * Discovery-first OAuth endpoint resolution (RFC 8414 / OIDC Discovery 1.0).
 *
 * AFPS lets an `oauth2` auth declare an `issuer` instead of (or alongside)
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
  /**
   * RFC 7591 §3 `registration_endpoint` as projected from the RFC 8414
   * authorization-server metadata document. Present when the IdP supports
   * OAuth 2.0 Dynamic Client Registration — the MCP-spec onboarding path
   * (`/oauth/register`). `undefined` when the document omits it. Consumed by
   * the auto-DCR orchestrator; never applied to the connect flow itself.
   */
  registrationEndpoint?: string;
  /**
   * RFC 8414 §2 `grant_types_supported` as projected from the discovery
   * document. Drives two MCP-spec refresh behaviours: registering a DCR client
   * for the `refresh_token` grant ONLY when the AS advertises it (else the AS
   * never issues a refresh token — Claude Code #7744), and deciding whether a
   * connection that came back without a refresh token is a misconfig (AS
   * supports refresh) or expected (AS issues access-only tokens, e.g. ClickUp
   * MCP). `undefined` when the document omits the field.
   */
  grantTypesSupported?: string[];
  /** The validated document's `issuer`, verbatim: what a client is bound to, `iss` compared with. */
  issuer?: string;
  authorizationResponseIssParameterSupported?: boolean;
}

export interface ResolveOAuthEndpointsInput {
  /** Issuer URL (RFC 8414 / OIDC). Discovery is skipped when absent. */
  issuer?: string;
  /** Explicit authorization endpoint — wins over discovery when present. */
  authorizationEndpoint?: string;
  /** Explicit token endpoint — wins over discovery when present. */
  tokenEndpoint?: string;
  /**
   * Injectable egress fetch for the discovery probes. Defaults to the
   * SSRF-guarded `oauthEgressFetch`. Tests inject a stub here rather than
   * patching the global `fetch` — the guarded default resolves DNS, which
   * would (correctly) fail-close on non-resolvable test hostnames.
   */
  fetchImpl?: typeof fetch;
}

/** Strip a single trailing slash so well-known suffixes join cleanly. */
function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** AFPS §7.12: two URL identifiers are equal once every trailing `/` is stripped. */
export function sameUrlIdentifier(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/**
 * AFPS §7.3 / RFC 8414 §3.3 — whether a discovery document describes `configuredIssuer`. A missing
 * `issuer` fails like a mismatched one (RFC 8414 §3.2 requires it). Shared with the conformance
 * harness.
 */
export function discoveryIssuerMatches(docIssuer: unknown, configuredIssuer: string): boolean {
  return (
    typeof docIssuer === "string" &&
    docIssuer !== "" &&
    sameUrlIdentifier(docIssuer, configuredIssuer)
  );
}

/**
 * Build the three probe URLs per AFPS §7.3 from a configured issuer.
 * Exported so the system-package conformance harness probes the SAME URLs the
 * connect engine does. Callers resolving endpoints should use
 * `resolveOAuthEndpoints`; this is for tooling that needs the raw document.
 */
export function buildDiscoveryProbes(issuer: string): string[] {
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

interface DiscoveredMetadata {
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  codeChallengeMethodsSupported?: string[];
  userinfoEndpoint?: string;
  registrationEndpoint?: string;
  grantTypesSupported?: string[];
  issuer?: string;
  authorizationResponseIssParameterSupported?: boolean;
}

/**
 * Per-issuer discovery results, keyed like the §7.3 equality check. The cap bounds a key space a
 * connection's user may grow (§7.3). A total failure is never stored: typically transient, it
 * would otherwise brick refresh of an issuer-only provider for the TTL.
 */
const discoveryCache = createCache<DiscoveredMetadata>({
  name: "oauth-discovery",
  ttlMs: 3_600_000,
  max: 500,
});

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
  const { issuer } = input;
  if (!issuer) {
    return {
      authorizationEndpoint: input.authorizationEndpoint,
      tokenEndpoint: input.tokenEndpoint,
    };
  }
  const configuredIssuer = issuer.replace(/\/+$/, "");
  const discovered = await discoveryCache.get(configuredIssuer, () =>
    discover(issuer, configuredIssuer, input.fetchImpl),
  );
  const { authorizationEndpoint, tokenEndpoint, ...enrichment } = discovered ?? {};
  // Manual endpoints always win — discovery fills only the gaps.
  return {
    authorizationEndpoint: input.authorizationEndpoint || authorizationEndpoint,
    tokenEndpoint: input.tokenEndpoint || tokenEndpoint,
    ...(Object.fromEntries(
      Object.entries(enrichment).filter(([, v]) => v !== undefined),
    ) as typeof enrichment),
  };
}

/** Probe the §7.3 locations of `issuer`; `undefined` when no document yielded anything. */
async function discover(
  issuer: string,
  configuredIssuer: string,
  fetchImpl: typeof fetch | undefined,
): Promise<DiscoveredMetadata | undefined> {
  const found: DiscoveredMetadata = {};
  for (const url of buildDiscoveryProbes(issuer)) {
    const doc = await fetchDiscoveryDocument(url, fetchImpl);
    if (!doc) continue;
    // AFPS §7.3: no field is trusted from a document of another issuer.
    if (!discoveryIssuerMatches(doc.issuer, configuredIssuer)) continue;
    found.issuer ??= doc.issuer as string;
    if (typeof doc.authorization_response_iss_parameter_supported === "boolean") {
      found.authorizationResponseIssParameterSupported ??=
        doc.authorization_response_iss_parameter_supported;
    }
    if (typeof doc.authorization_endpoint === "string") {
      found.authorizationEndpoint ??= doc.authorization_endpoint;
    }
    if (typeof doc.token_endpoint === "string") found.tokenEndpoint ??= doc.token_endpoint;
    // RFC 8414 §2 — the first well-shaped array; no default synthesised when absent.
    found.codeChallengeMethodsSupported ??= stringArray(doc.code_challenge_methods_supported);
    // OIDC Discovery 1.0 / RFC 7591 §3 — well-formed URLs only.
    found.userinfoEndpoint ??= urlString(doc.userinfo_endpoint);
    found.registrationEndpoint ??= urlString(doc.registration_endpoint);
    found.grantTypesSupported ??= stringArray(doc.grant_types_supported);
    if (
      found.authorizationEndpoint &&
      found.tokenEndpoint &&
      found.codeChallengeMethodsSupported !== undefined &&
      found.userinfoEndpoint !== undefined
    ) {
      break;
    }
  }
  return Object.values(found).some((v) => v !== undefined) ? found : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v): v is string => typeof v === "string")
    ? value
    : undefined;
}

function urlString(value: unknown): string | undefined {
  return typeof value === "string" && URL.canParse(value) ? value : undefined;
}

interface DiscoveryDocument {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  userinfo_endpoint?: unknown;
  code_challenge_methods_supported?: unknown;
  registration_endpoint?: unknown;
  grant_types_supported?: unknown;
  authorization_response_iss_parameter_supported?: unknown;
}

/** Best-effort fetch + parse of a discovery document. Returns `null` on any failure. */
async function fetchDiscoveryDocument(
  url: string,
  fetchImpl?: typeof fetch,
): Promise<DiscoveryDocument | null> {
  // SSRF-guarded, matching the now-guarded token exchange to the same host.
  // The probe host comes from the manifest-author-controlled `issuer`; a host
  // resolving to a private/link-local/metadata address makes `oauthEgressFetch`
  // throw `SsrfBlockedError`, which the catch below turns into the same
  // best-effort `null` as any other discovery failure. Self-hosted deployments
  // that legitimately run an internal IdP opt that host into the SSRF bypass via
  // `EGRESS_ALLOW_INTERNAL_HOSTS`.
  try {
    const doFetch = fetchImpl ?? oauthEgressFetch;
    const res = await doFetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = await readJsonUnder(res);
    if (!json || typeof json !== "object") return null;
    return json as DiscoveryDocument;
  } catch {
    // Best-effort: discovery failures fall back to manual endpoints. Swallow.
    return null;
  }
}
