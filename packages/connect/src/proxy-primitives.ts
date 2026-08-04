// SPDX-License-Identifier: Apache-2.0

/**
 * Shared primitives used by the credential-proxy server route
 * (`apps/api/src/routes/credential-proxy.ts`) and the in-container
 * sidecar (`runtime-pi/sidecar/app.ts`). Both code paths implement the
 * same wire protocol (X-Integration-Id/X-Target/Set-Cookie passthrough) and
 * share the AFPS spec-compliant URL allowlist matcher so drift is
 * impossible by construction.
 */

import {
  planHttpDeliveryInjection,
  substituteVars as substituteVarsCore,
  type HttpDeliveryInjectionDecision,
} from "@appstrate/afps-runtime/resolvers";

/**
 * Substitute `{{field}}` placeholders in `input` using `credentials`.
 *
 * Whitespace inside the `{{…}}` is tolerated so hand-written templates
 * can keep `{{ field }}`. Unknown placeholders are **left intact**
 * (`keepUnresolved`) — callers MAY inspect the result via
 * {@link findUnresolvedPlaceholders} to fail closed, matching the
 * sidecar's defensive pattern. Delegates to the single canonical
 * implementation in `@appstrate/afps-runtime`.
 */
export function substituteVars(input: string, credentials: Record<string, string>): string {
  return substituteVarsCore(input, credentials, { keepUnresolved: true });
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
 * AFPS spec-compliant URL allowlist matcher. Re-exported from
 * `@appstrate/afps-runtime/resolvers` so the credential-proxy route,
 * the sidecar, and the in-bundle `http-call-core` all enforce the exact
 * same glob semantics by construction.
 */
export { matchesAuthorizedUriSpec } from "@appstrate/afps-runtime/resolvers";

/**
 * Payload produced by the platform's DB-backed integration credential
 * resolver (`apps/api/src/services/integration-credentials-resolver.ts`) and
 * by the sidecar's `/internal/integration-credentials` HTTP fetch (container,
 * HTTP-backed). Single type definition — both entrypoints import it from here,
 * so the wire format cannot drift between platform and sidecar.
 *
 * Lives in `proxy-primitives.ts` (not a `@appstrate/db`-importing module) so
 * the sidecar can consume it via the `@appstrate/connect/proxy-primitives`
 * subpath without pulling in the DB layer.
 */
export interface ProxyCredentialsPayload {
  /** Credential fields keyed by name (e.g. `access_token`, `api_key`, `subdomain`, ...). */
  credentials: Record<string, string>;
  /** URL allowlist per AFPS §7.5 — `null` means no whitelist, SSRF safety net applies. */
  authorizedUris: string[] | null;
  /** When true, skip allowlist enforcement (still block private/internal ranges). */
  allowAllUris: boolean;
  /**
   * Header name the upstream expects the credential under
   * (e.g. `Authorization`, `X-Api-Key`). Absent = the proxy does not
   * inject any header and the agent is expected to write its own auth
   * (basic/custom modes, or providers that pass credentials via URL /
   * query / body). Pinned server-side so the agent cannot alter it.
   */
  credentialHeaderName?: string;
  /**
   * Literal prefix prepended to the credential value — typically `Bearer `
   * for OAuth, empty for most API-key providers. For compatibility, a bare
   * RFC auth-scheme token such as `Bearer` gets one separator only when the
   * target is Authorization or Proxy-Authorization.
   */
  credentialHeaderPrefix?: string;
  /**
   * Whether a caller-supplied header with the same name wins. Optional for
   * rolling compatibility; absent follows the AFPS default (`false`).
   */
  credentialAllowServerOverride?: boolean;
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
 * fields the injector needs without also filling in `authorizedUris`
 * / `allowAllUris` boilerplate.
 */
type InjectableCredentials = Pick<
  ProxyCredentialsPayload,
  | "credentials"
  | "credentialHeaderName"
  | "credentialHeaderPrefix"
  | "credentialAllowServerOverride"
  | "credentialFieldName"
>;

function planInjectedCredentialHeader(
  creds: InjectableCredentials,
  callerHeaderNames: readonly string[],
): HttpDeliveryInjectionDecision {
  if (!creds.credentialHeaderName) return { kind: "none" };
  return planHttpDeliveryInjection(
    {
      headerName: creds.credentialHeaderName,
      headerPrefix: creds.credentialHeaderPrefix ?? "",
      value: creds.credentials[creds.credentialFieldName] ?? "",
      allowServerOverride: creds.credentialAllowServerOverride === true,
    },
    callerHeaderNames,
  );
}

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
  const decision = planInjectedCredentialHeader(creds, []);
  return decision.kind === "inject" ? decision.header : undefined;
}

/**
 * Apply {@link buildInjectedCredentialHeader} onto an existing header
 * map in-place. The platform credential replaces a case-insensitive caller
 * match by default. A caller header is preserved only when the manifest
 * explicitly declares `allowServerOverride: true`.
 */
export function applyInjectedCredentialHeader(
  headers: Record<string, string>,
  creds: InjectableCredentials,
): HttpDeliveryInjectionDecision {
  const decision = planInjectedCredentialHeader(creds, Object.keys(headers));
  if (decision.kind !== "inject") return decision;
  const lower = decision.header.name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
  headers[decision.header.name] = decision.header.value;
  return decision;
}

/**
 * Same as {@link applyInjectedCredentialHeader} but for a `Headers`
 * instance. Platform path uses `Headers` (streaming-friendly), sidecar
 * uses a plain record — both converge on the same injection semantics.
 */
export function applyInjectedCredentialHeaderToHeaders(
  headers: Headers,
  creds: InjectableCredentials,
): HttpDeliveryInjectionDecision {
  const decision = planInjectedCredentialHeader(creds, [...headers.keys()]);
  if (decision.kind !== "inject") return decision;
  headers.set(decision.header.name, decision.header.value);
  return decision;
}

/**
 * Repair a malformed `Authorization` / `Proxy-Authorization` scheme in a
 * caller **template**, before substitution: `Bearer{{access_token}}` →
 * `Bearer {{access_token}}`. LLMs writing the free-form `api_call` headers
 * surface sometimes concatenate the scheme and the placeholder without a
 * space, which substitution would expand to `Bearerghp_…` — a hard 401
 * upstream.
 *
 * The repair is anchored on `{{`, so it fires only on the authoring defect
 * it exists for. Running it on the *resolved* value instead (which is what
 * this used to do, issue #988) matched any secret whose first bytes happen
 * to spell a scheme name — `tokenlive_sk_123` became `token live_sk_123`,
 * silently corrupting a valid credential into a 401 that looked like the
 * user's fault. A template can never be a secret, so there is no such
 * false positive here.
 *
 * Returns the value unchanged for every header name other than the two
 * auth headers, so callers can pipe every header through it.
 */
export function normalizeAuthSchemeTemplate(headerName: string, rawValue: string): string {
  const lower = headerName.toLowerCase();
  if (lower !== "authorization" && lower !== "proxy-authorization") return rawValue;
  return rawValue.replace(/^(Bearer|Basic|Token)(?=\{\{)/i, "$1 ");
}

/**
 * {@link normalizeAuthSchemeTemplate} over a whole header-template record.
 * Returns a new record — the caller's input is never mutated, so the
 * unrepaired templates stay available if a caller needs to echo them.
 */
export function normalizeAuthSchemeTemplates(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = normalizeAuthSchemeTemplate(key, value);
  }
  return out;
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
 * Clone an UPSTREAM RESPONSE's headers for relay downstream, dropping the
 * headers a proxy must not forward: RFC 7230 hop-by-hop headers plus
 * `content-encoding`/`content-length`. Bun's `fetch` auto-decompresses the
 * body, so a forwarded `content-encoding: gzip` would tell the caller to
 * inflate plaintext (ZlibError / opaque connection error), and the original
 * `content-length` described the now-stale compressed payload — the re-wrapped
 * `Response` recomputes length from the decompressed body. `extraSkip` drops
 * additional entrypoint-specific transport headers (e.g. `x-stream-*`).
 * Preserves the original header casing.
 */
export function stripUpstreamResponseHeaders(src: Headers, extraSkip?: Set<string>): Headers {
  const out = new Headers();
  src.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) return;
    if (lower === "content-encoding" || lower === "content-length") return;
    if (extraSkip?.has(lower)) return;
    out.set(key, value);
  });
  return out;
}

/**
 * Strip host, content-length, and RFC 7230 hop-by-hop headers. `extraSkip`
 * provides a hook for entrypoint-specific control headers (e.g.
 * `x-integration`, `x-target`) that must also be kept out of the upstream
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
