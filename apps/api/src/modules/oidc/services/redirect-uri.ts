// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth `redirect_uri` validation — extracted into a standalone service so
 * both the route layer (`routes.ts` via Zod refinement) and the service
 * layer (`oauth-admin.ts` defense-in-depth) can import it without forming
 * a circular dependency.
 *
 * Defense layers (in order):
 * 1. Must parse as an absolute URL.
 * 2. `http:` is allowed only when the host is loopback (`localhost` and any
 *    RFC 6761 `.localhost` subdomain, `127.0.0.0/8`, `::1` — RFC 8252 §7.3),
 *    regardless of environment. Native and CLI clients are loopback-only by
 *    construction, and a redirect URI is a browser navigation target — never
 *    a URL the server fetches — so the SSRF concern that gates outbound
 *    loopback does not apply.
 *
 *    The predicate is the SAME `isLoopbackHost` the Dynamic Client
 *    Registration path uses (`@better-auth/core/utils/host`, reached from
 *    `SafeUrlSchema` inside `@better-auth/oauth-provider`), so the admin path
 *    accepts exactly what DCR accepts — a local re-implementation would drift
 *    on the edge forms upstream normalizes (IPv4-mapped IPv6, zone ids,
 *    trailing dots, `tenant.localhost`), which is the asymmetry #1012 is
 *    about. Upstream's docstring steers redirect *matching* to `isLoopbackIP`;
 *    that warning is about matching an authorization request against a
 *    registration, not about registration policy, where `SafeUrlSchema`
 *    itself uses `isLoopbackHost`.
 * 3. Every other host must be `https:` AND must not resolve to a blocked
 *    network: SSRF targets (RFC1918, link-local `169.254.0.0/16`, cloud
 *    metadata, loopback, IPv6 variants). Enforced via
 *    `@appstrate/core/ssrf:isBlockedUrl`, the same helper used by the
 *    webhooks delivery path. Non-`http:`/`https:` schemes
 *    (`javascript:`/`data:`/`file:`) fall through to `false`.
 */

import { isBlockedUrl } from "@appstrate/core/ssrf";
import { isLoopbackHost } from "@better-auth/core/utils/host";

export function isValidRedirectUri(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol === "http:") {
    return isLoopbackHost(parsed.hostname);
  }
  if (parsed.protocol === "https:") {
    return !isBlockedUrl(raw);
  }
  return false;
}
