// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side redirect-URI pre-check for the OAuth client form.
 *
 * The API (`isValidRedirectUri`, RFC 8252 §7.3) is the authority; this is
 * intentionally a SUPERSET of its rule so the form fails fast without ever
 * rejecting what the server accepts (e.g. `http://127.0.0.1/cb`, `http://[::1]/cb`).
 */
export function looksLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]" || host === "::1") return true;
  // IPv4 loopback range 127.0.0.0/8, plus its IPv4-mapped IPv6 spellings.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return /^\[::ffff:(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|7f[0-9a-f]{2}:[0-9a-f]{1,4})\]$/.test(host);
}
