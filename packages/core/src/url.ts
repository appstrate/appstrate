// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/** Protocols accepted by {@link normalizeHttpUrl}. */
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Parse an absolute URL and return the WHATWG-normalized href when its protocol
 * is HTTP(S), or `null` otherwise.
 *
 * This helper establishes only URL syntax and the protocol allowlist. It is
 * suitable for navigation targets, but it is not an origin-trust or SSRF
 * decision: callers with either requirement must apply their own policy too.
 */
export function normalizeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return HTTP_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
}
