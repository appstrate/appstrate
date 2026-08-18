// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth authorization-server metadata check for `oauth2` auths.
 *
 * Every field a manifest declares about a provider's OAuth surface —
 * `token_endpoint_auth_method`, `authorization_endpoint`, `token_endpoint`,
 * `userinfo_endpoint` — is hand-transcribed from that provider's docs, and a
 * wrong value is invisible until a real user tries to connect: the browser
 * lands on an opaque provider error, or the token exchange fails with
 * `invalid_client`. That is exactly how a manifest declaring
 * `client_secret_post` against a provider that only accepts HTTP Basic
 * shipped undetected.
 *
 * Many providers publish those same facts as machine-readable metadata (RFC
 * 8414 `/.well-known/oauth-authorization-server`, OIDC Discovery
 * `/.well-known/openid-configuration`). Where such a document exists it is
 * authoritative, and comparing it to the manifest turns a class of silent
 * misconfiguration into a deterministic check that needs no credentials, no
 * OAuth app and no user consent.
 *
 * Coverage is partial BY CONSTRUCTION and that is reported, not hidden: a
 * provider that publishes nothing (Airtable, GitHub, Slack, Notion, …) yields
 * an `info` "no metadata document" line rather than silence, so the report
 * distinguishes "verified" from "unverifiable" instead of letting the second
 * read as the first.
 *
 * Network-bound → runs in the `mcp`/`all` tiers, never in the default `gate`.
 */

import type { SystemPackageEntry } from "@appstrate/core/system-packages";
import type { Finding, Severity } from "./types.ts";
import { ssrfGuardedFetch } from "./ssrf-fetch.ts";

const CHECK = "oauth-metadata";

/** Timeout for a single metadata fetch. Providers are third parties. */
const FETCH_TIMEOUT_MS = 10_000;

/** The subset of AS metadata this check reads. */
interface AsMetadata {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  userinfo_endpoint?: unknown;
  token_endpoint_auth_methods_supported?: unknown;
}

interface OAuthAuth {
  type?: unknown;
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  userinfo_endpoint?: unknown;
  token_endpoint_auth_method?: unknown;
}

/** Read the manifest's `auths` map, tolerating a missing/foreign shape. */
function oauthAuths(manifest: Record<string, unknown>): Array<[string, OAuthAuth]> {
  const auths = manifest.auths;
  if (!auths || typeof auths !== "object") return [];
  return Object.entries(auths as Record<string, unknown>)
    .filter((e): e is [string, OAuthAuth] => {
      const a = e[1];
      return !!a && typeof a === "object" && (a as OAuthAuth).type === "oauth2";
    })
    .map(([k, a]) => [k, a as OAuthAuth]);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Whether the auth declares ANY way to resolve an account identity — an
 * `identity_claims` map (which may read OIDC `id_token` claims with no HTTP
 * call at all) or an explicit `userinfo_endpoint`.
 */
function declaresIdentity(auth: OAuthAuth): boolean {
  const claims = (auth as { identity_claims?: unknown }).identity_claims;
  const hasClaims =
    !!claims && typeof claims === "object" && Object.keys(claims as object).length > 0;
  return hasClaims || str(auth.userinfo_endpoint) !== undefined;
}

/**
 * How much authority a discovered document carries.
 *
 *   - `issuer`  — the manifest names an `issuer` and the document was fetched
 *     from that issuer's well-known path, with a matching `issuer` claim. RFC
 *     8414 §3.3 makes this binding: the document describes THIS authorization
 *     server, so a contradiction is a manifest defect.
 *   - `probed`  — no issuer was declared, so the document was found by probing
 *     the origin of the declared `token_endpoint`. That origin may host a
 *     DIFFERENT authorization server than the one the manifest targets —
 *     `api.hubapi.com` publishes metadata for HubSpot's MCP server, not for
 *     classic app OAuth — so a contradiction is a lead to investigate, not a
 *     proven defect, and is reported as a warning.
 */
type Trust = "issuer" | "probed";

/**
 * Candidate metadata URLs for an auth, most authoritative first.
 *
 * A declared `issuer` gets the two spec-mandated well-known paths built from
 * it. Without an issuer we fall back to probing the origin of the declared
 * `token_endpoint` — providers that publish metadata usually serve it from the
 * same origin, and a 404 costs one request — but everything that comes back
 * that way is marked `probed`.
 */
export function metadataCandidates(auth: OAuthAuth): Array<{ url: string; trust: Trust }> {
  const out: Array<{ url: string; trust: Trust }> = [];
  const add = (url: string, trust: Trust): void => {
    if (!out.some((c) => c.url === url)) out.push({ url, trust });
  };

  const issuer = str(auth.issuer);
  if (issuer) {
    try {
      const url = new URL(issuer);
      const path = url.pathname.replace(/\/+$/, "");
      // RFC 8414 §3.1 INSERTS the well-known segment between host and issuer
      // path (`https://host/.well-known/oauth-authorization-server/tenant`),
      // while OIDC Discovery §4 APPENDS it
      // (`https://host/tenant/.well-known/openid-configuration`). A
      // path-bearing issuer — every multi-tenant authorization server — is
      // served at one location and 404s at the other, so probing only the
      // appended form reports "publishes nothing" for a server that publishes
      // plenty. Both forms are tried; they coincide when the issuer carries no
      // path, and `add` drops the duplicate.
      add(`${url.origin}/.well-known/oauth-authorization-server${path}`, "issuer");
      add(`${url.origin}${path}/.well-known/openid-configuration`, "issuer");
      add(`${url.origin}${path}/.well-known/oauth-authorization-server`, "issuer");
    } catch {
      // A malformed issuer is the schema's problem, not this check's.
    }
  }

  const tokenEndpoint = str(auth.token_endpoint);
  if (tokenEndpoint) {
    try {
      const origin = new URL(tokenEndpoint).origin;
      add(`${origin}/.well-known/openid-configuration`, "probed");
      add(`${origin}/.well-known/oauth-authorization-server`, "probed");
    } catch {
      // A malformed token_endpoint is the schema's problem, not this check's.
    }
  }
  return out;
}

/**
 * Whether a metadata document may be treated as describing `declaredIssuer`.
 *
 * RFC 8414 §3.2 makes `issuer` REQUIRED in the document and §3.3 makes the
 * client reject any document whose `issuer` does not match the one it asked
 * about. A MISSING claim is refused for the same reason a mismatched one is:
 * without it nothing ties the document to this authorization server, and
 * issuer trust is exactly what promotes a contradiction from a warning to a
 * `fail` that opens an issue against a manifest that may well be correct.
 */
export function issuerBinds(published: unknown, declaredIssuer: string): boolean {
  const value = str(published);
  if (!value) return false;
  const normalize = (v: string): string => v.replace(/\/+$/, "");
  return normalize(value) === normalize(declaredIssuer);
}

/**
 * Fetch the first candidate that answers with a JSON object.
 *
 * A document reached from a declared `issuer` is additionally required to
 * carry that same `issuer` claim (RFC 8414 §3.3). Without that check a
 * provider serving an unrelated authorization server's metadata under the
 * well-known path would be compared against the wrong facts — the same
 * confusion that makes `probed` documents non-binding, but silent.
 */
async function fetchMetadata(
  candidates: Array<{ url: string; trust: Trust }>,
  declaredIssuer: string | undefined,
): Promise<{ url: string; trust: Trust; metadata: AsMetadata } | undefined> {
  for (const { url, trust } of candidates) {
    try {
      const res = await ssrfGuardedFetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const body: unknown = await res.json();
      if (!body || typeof body !== "object") continue;
      const metadata = body as AsMetadata;
      if (trust === "issuer" && declaredIssuer && !issuerBinds(metadata.issuer, declaredIssuer)) {
        continue;
      }
      return { url, trust, metadata };
    } catch {
      // Unreachable / non-JSON / blocked → try the next candidate. A provider
      // that publishes nothing is the common case, not an error.
    }
  }
  return undefined;
}

/**
 * Compare one manifest auth against the provider's published metadata.
 *
 * Severities are chosen so the check can run unattended:
 *   - `fail` — an `issuer`-bound document contradicts the manifest. The
 *     document provably describes this authorization server, so this is a
 *     real, connect-breaking defect.
 *   - `warn` — a `probed` document contradicts the manifest (it may describe
 *     a different AS on the same origin — a lead, not a verdict), or the
 *     manifest declares no identity mechanism while the provider publishes a
 *     `userinfo_endpoint`.
 *   - `info`  — verified, or no document to verify against.
 */
export function compareAuth(
  packageId: string,
  authKey: string,
  auth: OAuthAuth,
  metadata: AsMetadata,
  metadataUrl: string,
  trust: Trust,
): Finding[] {
  const findings: Finding[] = [];
  const where = `auth '${authKey}' vs ${metadataUrl}`;
  // Only an issuer-bound document can convict a manifest; see `Trust`.
  const contradiction: Severity = trust === "issuer" ? "fail" : "warn";
  const caveat =
    trust === "issuer"
      ? ""
      : " (metadata found by probing the token_endpoint origin, so it may describe a different authorization server — verify against the provider's docs before changing the manifest)";

  // `token_endpoint_auth_method` — the failure this check exists for.
  const supported = Array.isArray(metadata.token_endpoint_auth_methods_supported)
    ? metadata.token_endpoint_auth_methods_supported.filter(
        (m): m is string => typeof m === "string",
      )
    : undefined;
  // RFC 6749 §2.3.1 makes HTTP Basic the method every AS must accept, so an AS
  // that publishes nothing is assumed to take `client_secret_basic` — which is
  // also this platform's default when a manifest omits the field.
  const declaredMethod = str(auth.token_endpoint_auth_method) ?? "client_secret_basic";
  if (supported && supported.length > 0) {
    if (supported.includes(declaredMethod)) {
      findings.push({
        packageId,
        check: CHECK,
        severity: "info",
        message: `${where}: token_endpoint_auth_method '${declaredMethod}' is supported`,
      });
    } else {
      findings.push({
        packageId,
        check: CHECK,
        severity: contradiction,
        message: `${where}: token_endpoint_auth_method '${declaredMethod}' is NOT in token_endpoint_auth_methods_supported [${supported.join(", ")}] — the token exchange will fail with invalid_client${caveat}`,
      });
    }
  }

  // Endpoints. A mismatch here means the connect flow talks to a URL the
  // provider no longer considers current — the redirect works, the exchange
  // does not.
  for (const field of ["authorization_endpoint", "token_endpoint", "userinfo_endpoint"] as const) {
    const declared = str(auth[field]);
    const published = str(metadata[field]);
    if (!published) continue;
    if (!declared) {
      // Only a missing IDENTITY mechanism is worth flagging. An auth that maps
      // `identity_claims` onto OIDC `id_token` claims (every Google
      // integration here) resolves an account without ever calling userinfo,
      // so demanding the endpoint too would be noise.
      if (field === "userinfo_endpoint" && !declaresIdentity(auth)) {
        findings.push({
          packageId,
          check: CHECK,
          severity: "warn",
          message: `${where}: provider publishes userinfo_endpoint '${published}' and the manifest declares no identity mechanism — connections fall back to accountId "default" and are labelled "Connexion N"`,
        });
      }
      continue;
    }
    if (declared !== published) {
      findings.push({
        packageId,
        check: CHECK,
        severity: contradiction,
        message: `${where}: ${field} '${declared}' ≠ published '${published}'${caveat}`,
      });
    }
  }

  return findings;
}

/** Run the metadata check for every `oauth2` auth on one package. */
export async function checkOAuthMetadata(entry: SystemPackageEntry): Promise<Finding[]> {
  const auths = oauthAuths(entry.manifest);
  if (auths.length === 0) return [];

  const findings: Finding[] = [];
  for (const [authKey, auth] of auths) {
    const found = await fetchMetadata(metadataCandidates(auth), str(auth.issuer));
    if (!found) {
      findings.push({
        packageId: entry.packageId,
        check: CHECK,
        severity: "info",
        message: `auth '${authKey}': no metadata document published — declarations are UNVERIFIED here (only a live token exchange can confirm them)`,
      });
      continue;
    }
    findings.push(
      ...compareAuth(entry.packageId, authKey, auth, found.metadata, found.url, found.trust),
    );
  }
  return findings;
}
