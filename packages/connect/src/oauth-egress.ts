// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth egress fetch — the single outbound primitive for the secret-bearing
 * OAuth flows (authorization-code exchange, refresh, issuer discovery).
 *
 * These requests carry `client_secret` / `refresh_token` (POST) or the user's
 * bearer access token (userinfo GET), so they MUST be fail-closed against SSRF:
 * a manifest-declared `token_endpoint` / `issuer` whose host resolves to a
 * private, link-local, loopback or metadata address could otherwise exfiltrate
 * the secret to internal infrastructure. Every such request therefore goes
 * through {@link guardedFetch} (per-hop DNS + blocklist, manual redirects,
 * userinfo/fragment stripping), which throws {@link SsrfBlockedError} on a
 * blocked host.
 *
 * Escape hatch for self-hosting: some operators legitimately run an internal
 * IdP on a private address. `OAUTH_ALLOWED_INTERNAL_IDP_HOSTS` (comma-separated
 * hostnames) is an OPT-IN allowlist — when the target host matches an entry the
 * operator has explicitly trusted, the host blocklist is skipped for it. The
 * request still goes through {@link guardedFetch} so the manual-redirect
 * discipline (cross-origin credential + body stripping) holds — a trusted IdP
 * that open-redirects cannot forward the secret to a third origin. Empty/unset
 * ⇒ every OAuth egress host is guarded (the secure default).
 */

import { getEnv } from "@appstrate/env";
import { guardedFetch, SsrfBlockedError } from "@appstrate/core/ssrf";

export { SsrfBlockedError };

/**
 * Parse `OAUTH_ALLOWED_INTERNAL_IDP_HOSTS` into a lowercased hostname set.
 * Recomputed per call so a hot env reload is honoured without a restart; the
 * split is trivial next to the network round-trip that follows.
 */
function allowedInternalIdpHosts(): Set<string> {
  const raw = getEnv().OAUTH_ALLOWED_INTERNAL_IDP_HOSTS;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0),
  );
}

/** True when `host` is in the operator's opt-in internal-IdP allowlist. */
export function isAllowedInternalIdpHost(host: string): boolean {
  return allowedInternalIdpHosts().has(host.toLowerCase());
}

/**
 * SSRF-guarded `fetch` for secret-bearing OAuth egress, with an opt-in bypass
 * for operator-trusted internal IdP hosts (`OAUTH_ALLOWED_INTERNAL_IDP_HOSTS`).
 *
 * `fetch`-compatible for the `(url, init)` call shape. Throws
 * {@link SsrfBlockedError} when a non-allowlisted host resolves to a blocked
 * (private/link-local/loopback/metadata) address.
 */
export async function oauthEgressFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  // Always route through guardedFetch; the operator's opt-in allowlist only
  // relaxes the HOST blocklist (via `allowHost`), never the redirect discipline.
  return guardedFetch(input, init, { allowHost: isAllowedInternalIdpHost });
}
