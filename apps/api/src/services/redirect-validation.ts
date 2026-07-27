// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers for validating an organization's allowed redirect domains and
 * detecting the dev environment (used by OAuth redirect-URI + webhook URL
 * checks).
 */

import { getEnv } from "@appstrate/env";

export const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * RFC 8252 §7.3 loopback test for a URL hostname, as returned by
 * `new URL(...).hostname` (which normalizes numeric IPv4 forms to a dotted
 * quad — `127.1` / `0x7f000001` / `2130706433` all become `127.0.0.1` — and
 * keeps the surrounding brackets on IPv6 literals).
 *
 * Covers the three loopback forms the RFC puts on equal footing, unlike
 * {@link LOCALHOST_HOSTS} which only lists the single literals `localhost`
 * and `127.0.0.1`:
 *   - the literal name `localhost`
 *   - the entire IPv4 loopback range `127.0.0.0/8` (not just `127.0.0.1`)
 *   - the IPv6 loopback `[::1]`
 *
 * Used to allow `http://` redirect URIs for native/CLI OAuth clients, which
 * are loopback-only by construction. A redirect URI is a browser navigation
 * target, never a URL the server fetches, so the SSRF gate that blocks
 * loopback for outbound requests does not apply here.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost") return true;
  // `new URL("http://[::1]/").hostname` keeps the brackets; accept both forms.
  if (host === "[::1]" || host === "::1") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  return octets[0] === 127 && octets.every((octet) => octet <= 255);
}

/**
 * Check if the current environment is development (allow http://localhost).
 * If APP_URL contains localhost, we're in dev.
 */
export function isDevEnvironment(): boolean {
  try {
    return LOCALHOST_HOSTS.has(new URL(getEnv().APP_URL).hostname);
  } catch {
    return false;
  }
}

/**
 * Validate a list of domains for the allowedRedirectDomains setting.
 * Returns an error message if invalid, or null if all valid.
 */
export function validateDomainList(domains: string[]): string | null {
  if (!Array.isArray(domains)) {
    return "allowedRedirectDomains must be an array of strings";
  }

  if (domains.length > 20) {
    return "Maximum 20 allowed redirect domains";
  }

  const domainPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

  for (const domain of domains) {
    if (typeof domain !== "string") {
      return "Each domain must be a string";
    }
    if (!domainPattern.test(domain)) {
      return `Invalid domain: '${domain}'`;
    }
    if (domain.length > 253) {
      return `Domain too long: '${domain}'`;
    }
  }

  return null;
}
