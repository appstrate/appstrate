/**
 * Validates OAuth return URLs against an organization's allowed redirect domains.
 *
 * Security layers:
 * 1. Scheme validation — only https:// (http://localhost for dev)
 * 2. Dangerous scheme blocking — javascript:, data:, vbscript:, file:
 * 3. Domain whitelist matching — parsed host vs allowed domains
 * 4. localhost always allowed in dev mode
 */

import { getEnv } from "@appstrate/env";
import { invalidRequest } from "../lib/errors.ts";

const DANGEROUS_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:"]);
export const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1"]);

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
 * Validate a returnUrl against an organization's allowed redirect domains.
 * Throws ApiError if invalid.
 */
export function validateReturnUrl(returnUrl: string, allowedDomains: string[]): void {
  // Block protocol-relative URLs
  if (returnUrl.startsWith("//")) {
    throw invalidRequest("Protocol-relative URLs are not allowed", "returnUrl");
  }

  let parsed: URL;
  try {
    parsed = new URL(returnUrl);
  } catch {
    throw invalidRequest("Malformed URL", "returnUrl");
  }

  // Block dangerous schemes
  if (DANGEROUS_SCHEMES.has(parsed.protocol)) {
    throw invalidRequest(`Scheme '${parsed.protocol}' is not allowed`, "returnUrl");
  }

  const isDev = isDevEnvironment();
  const isLocalhost = LOCALHOST_HOSTS.has(parsed.hostname);

  // Enforce HTTPS (except http://localhost in dev)
  if (parsed.protocol !== "https:") {
    if (!(parsed.protocol === "http:" && isLocalhost && isDev)) {
      throw invalidRequest("Only https:// URLs are allowed", "returnUrl");
    }
  }

  // Localhost is always allowed in dev mode (skip domain whitelist)
  if (isLocalhost && isDev) {
    return;
  }

  // Check against whitelist
  const hostname = parsed.hostname.toLowerCase();
  const isAllowed = allowedDomains.some((domain) => {
    const d = domain.toLowerCase();
    return hostname === d || hostname.endsWith(`.${d}`);
  });

  if (!isAllowed) {
    throw invalidRequest(
      `Domain '${parsed.hostname}' is not in the allowed redirect domains`,
      "returnUrl",
    );
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
