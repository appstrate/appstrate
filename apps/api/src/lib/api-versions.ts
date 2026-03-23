/**
 * API version registry — date-based versioning (Stripe pattern).
 *
 * Each version is an ISO date string (YYYY-MM-DD). The org can pin to a version
 * via `organizations.settings.apiVersion`. Clients can override per-request
 * via the `Appstrate-Version` header.
 */

export const CURRENT_API_VERSION = "2026-03-21";

/** All versions the server can serve. Oldest first. */
export const SUPPORTED_VERSIONS = new Set(["2026-03-21"]);

/** Sunset dates for deprecated versions (version → sunset date). */
const SUNSET_DATES = new Map<string, string>();

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidVersionFormat(v: string): boolean {
  return ISO_DATE_RE.test(v);
}

export function isVersionSupported(v: string): boolean {
  return SUPPORTED_VERSIONS.has(v);
}

/** Returns the Sunset header value (HTTP-date) if the version is deprecated, null otherwise. */
export function getVersionSunsetDate(v: string): string | null {
  const iso = SUNSET_DATES.get(v);
  if (!iso) return null;
  return new Date(iso).toUTCString();
}
