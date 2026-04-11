// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth `redirect_uri` validation — extracted into a standalone service so
 * both the route layer (`routes.ts` via Zod refinement) and the service
 * layer (`oauth-admin.ts` defense-in-depth) can import it without forming
 * a circular dependency.
 *
 * Defense layers (in order):
 * 1. Must parse as an absolute URL.
 * 2. Scheme must be `https:` — `http:` is only allowed when pointing at
 *    `localhost`/`127.0.0.1` AND the platform itself is running in dev
 *    mode (`APP_URL` is HTTP/localhost). Production cannot register HTTP
 *    redirect URIs at all.
 * 3. Host must not resolve to a blocked network: SSRF targets (RFC1918,
 *    link-local `169.254.0.0/16`, cloud metadata, loopback in production,
 *    IPv6 variants), `javascript:`/`data:`/`file:` schemes. Enforced via
 *    `@appstrate/core/ssrf:isBlockedUrl`, which is the same helper used
 *    by the webhooks delivery path.
 *
 * Dev-mode localhost is explicitly re-allowed after the SSRF check so
 * satellites can register `http://localhost:5173/callback` etc. during
 * local development — only when `APP_URL` is itself a localhost URL.
 */

import { isBlockedUrl } from "@appstrate/core/ssrf";
import { isDevEnvironment, LOCALHOST_HOSTS } from "../../../services/redirect-validation.ts";

export function isValidRedirectUri(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  const isLocalhost = LOCALHOST_HOSTS.has(parsed.hostname);
  if (parsed.protocol === "https:") {
    return !isBlockedUrl(raw);
  }
  if (parsed.protocol === "http:" && isLocalhost && isDevEnvironment()) {
    return true;
  }
  return false;
}
