// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth `redirect_uri` validation — extracted into a standalone service so
 * both the route layer (`routes.ts` via Zod refinement) and the service
 * layer (`oauth-admin.ts` defense-in-depth) can import it without forming
 * a circular dependency.
 *
 * Defense layers (in order):
 * 1. Must parse as an absolute URL.
 * 2. `http:` is allowed only when the host is loopback (`localhost`,
 *    `127.0.0.0/8`, `[::1]` — RFC 8252 §7.3), regardless of environment.
 *    Native and CLI clients are loopback-only by construction, and a
 *    redirect URI is a browser navigation target — never a URL the server
 *    fetches — so the SSRF concern that gates outbound loopback does not
 *    apply. This deliberately mirrors the Dynamic Client Registration path
 *    (`@better-auth/oauth-provider`), so an admin-registered client accepts
 *    exactly what DCR would accept.
 * 3. Every other host must be `https:` AND must not resolve to a blocked
 *    network: SSRF targets (RFC1918, link-local `169.254.0.0/16`, cloud
 *    metadata, loopback, IPv6 variants). Enforced via
 *    `@appstrate/core/ssrf:isBlockedUrl`, the same helper used by the
 *    webhooks delivery path. Non-`http:`/`https:` schemes
 *    (`javascript:`/`data:`/`file:`) fall through to `false`.
 */

import { isBlockedUrl } from "@appstrate/core/ssrf";
import { isLoopbackHost } from "../../../services/redirect-validation.ts";

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
