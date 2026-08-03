// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side redirect-URI pre-check for the OAuth client form.
 *
 * The API is the authority: `isValidRedirectUri` (api → `modules/oidc/services`)
 * accepts `https:` on any non-SSRF host, plus `http:` on any loopback host —
 * the exact predicate the Dynamic Client Registration path applies (RFC 8252
 * §7.3). This helper only exists so the form can fail fast without a round
 * trip, so it is intentionally a SUPERSET of the server rule: anything the
 * server accepts must pass here, and a few things the server refuses may pass
 * here too (the API then answers 400 and the form renders that message).
 *
 * Being stricter than the server is the bug this shape prevents: the form used
 * to require `hostname === "localhost"`, which rejected `http://127.0.0.1/cb`
 * and `http://[::1]/cb` in the dashboard even though the API accepts both
 * (#1012).
 */
export function looksLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]" || host === "::1") return true;
  // IPv4 loopback range 127.0.0.0/8, plus its IPv4-mapped IPv6 spellings.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return /^\[::ffff:(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|7f[0-9a-f]{2}:[0-9a-f]{1,4})\]$/.test(host);
}
