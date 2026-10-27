// SPDX-License-Identifier: Apache-2.0

/**
 * The headers describing the platform's own inbound request: who called, through what, under
 * which tenancy. They address the platform or were added on the way to it, so no proxy sends one
 * to an upstream; the credential proxy and both LLM proxies read this one rule, and each sets its
 * upstream's own auth on what remains.
 *   - the caller's platform credential: `authorization`, `cookie`;
 *   - where and as whom it acts: `x-org-id`, `x-space-id`, `x-run-id`, `x-view-as`;
 *   - the platform's markers and versioning: `x-appstrate-*`, `appstrate-*`;
 *   - the network path to the platform: `forwarded`, `via`, `x-forwarded-*`, `x-real-ip`,
 *     `true-client-ip`, `x-client-ip`, `x-original-forwarded-for`, `cdn-loop`, every Cloudflare
 *     `cf-*` header but the two a caller sends as its own credential to an upstream behind
 *     Cloudflare Access (`cf-access-client-id`, `cf-access-client-secret`);
 *   - identity asserted by an auth proxy in front of the platform, signed tokens among them
 *     (AWS ALB OIDC, Azure App Service, Google IAP, oauth2-proxy).
 */

const PLATFORM_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "x-org-id",
  "x-space-id",
  "x-run-id",
  // `VIEW_AS_HEADER` (`@appstrate/core/permissions`), named here so the sidecar, which reads this
  // rule, does not load the permission catalog; the unit test holds the two together.
  "x-view-as",
  "forwarded",
  "via",
  "x-real-ip",
  "true-client-ip",
  "x-client-ip",
  "x-original-forwarded-for",
  "cdn-loop",
]);

const PLATFORM_REQUEST_HEADER_PREFIXES = [
  "x-appstrate-",
  "appstrate-",
  "x-forwarded-",
  "cf-",
  "x-amzn-oidc-",
  "x-ms-client-principal",
  "x-ms-token-",
  "x-goog-iap-",
  "x-goog-authenticated-user-",
  "x-auth-request-",
] as const;

/** A Cloudflare Access service token: the caller's credential for its upstream, under `cf-`. */
const CALLER_UPSTREAM_CREDENTIALS: ReadonlySet<string> = new Set([
  "cf-access-client-id",
  "cf-access-client-secret",
]);

/** Whether `name` (any case) describes the platform's own inbound request, never sent upstream. */
export function isPlatformRequestHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (CALLER_UPSTREAM_CREDENTIALS.has(lower)) return false;
  return (
    PLATFORM_REQUEST_HEADERS.has(lower) ||
    PLATFORM_REQUEST_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}
