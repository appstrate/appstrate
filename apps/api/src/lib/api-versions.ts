// SPDX-License-Identifier: Apache-2.0

/**
 * API version registry — date-based versioning (Stripe pattern).
 *
 * Each version is an ISO date string (YYYY-MM-DD). The org can pin to a version
 * via `organizations.orgSettings.apiVersion`. Clients can override per-request
 * via the `Appstrate-Version` header.
 */

export const CURRENT_API_VERSION = "2026-03-21";

/** All versions the server can serve. Oldest first. */
export const SUPPORTED_VERSIONS = new Set(["2026-03-21"]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidVersionFormat(v: string): boolean {
  return ISO_DATE_RE.test(v);
}

export function isVersionSupported(v: string): boolean {
  return SUPPORTED_VERSIONS.has(v);
}
