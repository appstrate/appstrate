// SPDX-License-Identifier: Apache-2.0

/**
 * Shared primitives used by the credential-proxy server route
 * (`apps/api/src/routes/credential-proxy.ts`) and the in-container
 * sidecar (`runtime-pi/sidecar/app.ts`). Both code paths implement the
 * same wire protocol (X-Provider/X-Target/Set-Cookie passthrough) and
 * share the AFPS 1.3 spec-compliant URL allowlist matcher so drift is
 * impossible by construction.
 */

/**
 * Substitute `{{field}}` placeholders in `input` using `credentials`.
 *
 * Whitespace inside the `{{…}}` is tolerated so hand-written templates
 * can keep `{{ field }}`. Unknown placeholders are **left intact** —
 * callers MAY inspect the result via {@link findUnresolvedPlaceholders}
 * to fail closed, matching the sidecar's defensive pattern.
 */
export function substituteVars(input: string, credentials: Record<string, string>): string {
  return input.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    return key in credentials ? credentials[key]! : match;
  });
}

/** Return the names of every unresolved `{{field}}` still present in `input`. */
export function findUnresolvedPlaceholders(input: string): string[] {
  const out: string[] = [];
  for (const match of input.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
    out.push(match[1]!);
  }
  return out;
}

/**
 * AFPS 1.3 spec-compliant URL allowlist matcher. Re-exported from
 * `@appstrate/afps-runtime/resolvers` so the credential-proxy route,
 * the sidecar, and the in-bundle `provider-tool` all enforce the exact
 * same glob semantics by construction.
 */
export { matchesAuthorizedUriSpec } from "@appstrate/afps-runtime/resolvers";

/**
 * Payload returned by `resolveCredentialsForProxy` /
 * `forceRefreshCredentials` (platform, DB-backed) and by the sidecar's
 * `/internal/providers/credentials` HTTP fetch (container, HTTP-backed).
 * Single type definition — both entrypoints import it from here, so the
 * wire format cannot drift between platform and sidecar.
 *
 * Lives in `proxy-primitives.ts` rather than `credentials.ts` so the
 * sidecar (which must not pull @appstrate/db) can consume it via the
 * `@appstrate/connect/proxy-primitives` subpath.
 */
/**
 * Per-URL TLS client routing entry. Mirrored from
 * `@appstrate/core/validation::TlsClientByUrlEntry` to avoid pulling
 * `@appstrate/core` into the sidecar's tight dependency graph. The
 * shape is intentionally narrow — only `pattern` + `client` reach the
 * wire. See issue #403.
 */
export interface ProxyTlsClientByUrlEntry {
  pattern: string;
  client: "undici" | "curl";
}

export interface ProxyCredentialsPayload {
  /** Credential fields keyed by name (e.g. `access_token`, `api_key`, `subdomain`, ...). */
  credentials: Record<string, string>;
  /** URL allowlist per AFPS §7.5 — `null` means no whitelist, SSRF safety net applies. */
  authorizedUris: string[] | null;
  /** When true, skip allowlist enforcement (still block private/internal ranges). */
  allowAllUris: boolean;
  /**
   * Vendor extension `x-tlsClientByUrl`. When a resolved URL matches
   * one of these patterns the sidecar dispatches the request through
   * the named TLS client (currently `curl`) instead of the default
   * Bun/undici fetch — used to clear plain ClientHello mismatch checks
   * behind Cloudflare / Akamai / JA3/JA4 fingerprinting (issue #403).
   * Absent / empty = always use the default fetch path.
   */
  tlsClientByUrl?: ProxyTlsClientByUrlEntry[];
  /**
   * Header name the upstream expects the credential under
   * (e.g. `Authorization`, `X-Api-Key`). Absent = the proxy does not
   * inject any header and the agent is expected to write its own auth
   * (basic/custom modes, or providers that pass credentials via URL /
   * query / body). Pinned server-side so the agent cannot alter it.
   */
  credentialHeaderName?: string;
  /**
   * Prefix prepended to the credential value — typically `Bearer` for
   * OAuth, empty for most API-key providers. When set, the rendered
   * header is `${prefix} ${credentials[credentialFieldName]}`.
   */
  credentialHeaderPrefix?: string;
  /**
   * Name of the field in `credentials` that holds the secret to inject.
   * Always populated (defaults `access_token` / `api_key` by auth mode)
   * so both entrypoints can treat `credentialHeaderName` presence as the
   * single switch that controls injection.
   */
  credentialFieldName: string;
}

/**
 * Narrow subset the header-injection helpers actually read. Every
 * `ProxyCredentialsPayload` satisfies this shape trivially — the alias
 * exists so ad-hoc callers (tests, fixture builders) can construct the
 * four fields the injector needs without also filling in `authorizedUris`
 * / `allowAllUris` boilerplate.
 */
type InjectableCredentials = Pick<
  ProxyCredentialsPayload,
  "credentials" | "credentialHeaderName" | "credentialHeaderPrefix" | "credentialFieldName"
>;

/**
 * Build the final header-name / header-value pair the proxy injects
 * server-side from the platform-supplied credentials. Returns `undefined`
 * when the provider declares no `credentialHeaderName` (no injection
 * intended) or the referenced credential field is empty. The LLM never
 * touches the credential value — it only sees placeholder templates.
 */
export function buildInjectedCredentialHeader(
  creds: InjectableCredentials,
): { name: string; value: string } | undefined {
  if (!creds.credentialHeaderName) return undefined;
  const token = creds.credentials[creds.credentialFieldName];
  if (!token) return undefined;
  const prefix = creds.credentialHeaderPrefix?.trim();
  const value = prefix ? `${prefix} ${token}` : token;
  return { name: creds.credentialHeaderName, value };
}

/**
 * Apply {@link buildInjectedCredentialHeader} onto an existing header
 * map in-place. Caller headers win on case-insensitive match — if the
 * agent explicitly set the credential header (e.g. passing a per-call
 * token via input), we respect the override rather than clobbering it.
 */
export function applyInjectedCredentialHeader(
  headers: Record<string, string>,
  creds: InjectableCredentials,
): void {
  const injected = buildInjectedCredentialHeader(creds);
  if (!injected) return;
  const lower = injected.name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return; // caller override wins
  }
  headers[injected.name] = injected.value;
}

/**
 * Same as {@link applyInjectedCredentialHeader} but for a `Headers`
 * instance. Platform path uses `Headers` (streaming-friendly), sidecar
 * uses a plain record — both converge on the same injection semantics.
 */
export function applyInjectedCredentialHeaderToHeaders(
  headers: Headers,
  creds: InjectableCredentials,
): void {
  const injected = buildInjectedCredentialHeader(creds);
  if (!injected) return;
  const lower = injected.name.toLowerCase();
  let overridden = false;
  headers.forEach((_v, k) => {
    if (k.toLowerCase() === lower) overridden = true;
  });
  if (overridden) return;
  headers.set(injected.name, injected.value);
}

/**
 * Normalise malformed `Authorization` / `Proxy-Authorization` schemes in
 * place: `Bearertoken` → `Bearer token`. LLMs sometimes concatenate the
 * scheme and the placeholder without a space (`Bearer{{access_token}}`)
 * which substitution expands to `Bearertoken…` — upstreams reject that
 * with 401. Applied in both entrypoints so the fix is always on.
 */
export function normalizeAuthScheme(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (lower !== "authorization" && lower !== "proxy-authorization") continue;
    headers[key] = headers[key]!.replace(/^(Bearer|Basic|Token)(?=[^\s])/i, "$1 ");
  }
}

/**
 * Same as {@link normalizeAuthScheme} for a `Headers` instance.
 */
export function normalizeAuthSchemeOnHeaders(headers: Headers): void {
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower !== "authorization" && lower !== "proxy-authorization") return;
    const fixed = value.replace(/^(Bearer|Basic|Token)(?=[^\s])/i, "$1 ");
    if (fixed !== value) headers.set(key, fixed);
  });
}

/**
 * RFC 7230 §6.1 hop-by-hop headers — MUST NOT be forwarded by a proxy.
 * Used by both credential-proxy entrypoints to scrub forwarded headers
 * before they travel upstream or back downstream.
 */
export const HOP_BY_HOP_HEADERS = new Set<string>([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Strip host, content-length, and RFC 7230 hop-by-hop headers. `extraSkip`
 * provides a hook for entrypoint-specific control headers (e.g.
 * `x-provider`, `x-target`) that must also be kept out of the upstream
 * request.
 *
 * Preserves the original header casing from the caller.
 */
export function filterHeaders(
  headers: Record<string, string>,
  extraSkip?: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "content-length" ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      extraSkip?.has(lower)
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}
