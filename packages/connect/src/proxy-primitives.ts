// SPDX-License-Identifier: Apache-2.0

/**
 * Shared primitives used by the credential-proxy server route
 * (`apps/api/src/routes/credential-proxy.ts`) and the in-container
 * sidecar (`runtime-pi/sidecar/app.ts`). Both code paths implement the
 * same wire protocol (X-Provider/X-Target/Set-Cookie passthrough) but
 * evolved independently; this module is the single point of truth so
 * any future bug fix or hardening applies consistently.
 *
 * Two flavours of URL allowlist matching ship today:
 *
 *  - {@link matchesAuthorizedUriSpec}    — AFPS 1.3 spec-compliant. `*`
 *    matches a single path segment (no `/`), `**` matches any
 *    substring. Used by the external credential-proxy route.
 *
 *  - {@link matchesAuthorizedUriPrefix}  — legacy prefix-star + exact
 *    matching. `pattern*` → `url.startsWith(prefix)`. Used by the
 *    in-container sidecar today; kept for backwards compatibility with
 *    existing provider configurations that depend on the loose
 *    "anything after *" semantic.
 *
 * Unifying the two requires migrating provider configs in the wild —
 * tracked as a follow-up. Do NOT silently switch the sidecar to the
 * spec version: it will start rejecting URLs that match a pattern like
 * `https://api.example.com/v1*` against `/v1/foo/bar` (spec: no, only
 * single segment; prefix: yes).
 */

/**
 * Substitute `{{field}}` placeholders in `input` using `credentials`.
 *
 * Whitespace inside the `{{…}}` is tolerated so hand-written templates
 * can keep `{{ field }}`. Unknown placeholders are **left intact** —
 * callers MAY inspect the result via {@link findUnresolvedPlaceholders}
 * to fail closed, matching the sidecar's defensive pattern.
 */
export function substituteVars(input: string, credentials: Record<string, string>): string {
  return input.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    return key in credentials ? credentials[key]! : match;
  });
}

/** Return the names of every unresolved `{{field}}` still present in `input`. */
export function findUnresolvedPlaceholders(input: string): string[] {
  const out: string[] = [];
  for (const match of input.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
    out.push(match[1]!);
  }
  return out;
}

/**
 * AFPS 1.3 spec-compliant URL pattern matcher. Supports:
 *   - literal URLs (no wildcards)   → exact equality
 *   - `*`  (single path segment)    → regex `[^/]*`
 *   - `**` (any substring)          → regex `.*`
 *
 * All regex metacharacters in the pattern are escaped so the pattern
 * author cannot accidentally inject a regex.
 */
export function matchesAuthorizedUriSpec(pattern: string, target: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "§§DOUBLESTAR§§")
        .replace(/\*/g, "[^/]*")
        .replace(/§§DOUBLESTAR§§/g, ".*") +
      "$",
  );
  return regex.test(target);
}

/**
 * Legacy prefix-star URL matcher used by the in-container sidecar.
 * Kept in parity with `runtime-pi/sidecar/helpers.ts` pre-extraction.
 *
 * Semantics:
 *   - `pattern*` (ends with `*`) → `url.startsWith(pattern.slice(0, -1))`
 *   - otherwise                  → `url === pattern`
 *
 * Reminder: this is LESS strict than the spec version — a pattern like
 * `https://api.example.com/v1*` here matches `/v1/foo/bar`; the spec
 * version does not.
 */
export function matchesAuthorizedUriPrefix(pattern: string, target: string): boolean {
  if (pattern.endsWith("*")) {
    return target.startsWith(pattern.slice(0, -1));
  }
  return target === pattern;
}

/** Convenience: check a target against a list of patterns (legacy sidecar shape). */
export function matchesAnyAuthorizedUriPrefix(target: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesAuthorizedUriPrefix(p, target));
}

/**
 * RFC 7230 §6.1 hop-by-hop headers — MUST NOT be forwarded by a proxy.
 * Used by both credential-proxy entrypoints to scrub forwarded headers
 * before they travel upstream or back downstream.
 */
export const HOP_BY_HOP_HEADERS = new Set<string>([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Strip host, content-length, and RFC 7230 hop-by-hop headers. `extraSkip`
 * provides a hook for entrypoint-specific control headers (e.g.
 * `x-provider`, `x-target`) that must also be kept out of the upstream
 * request.
 *
 * Preserves the original header casing from the caller.
 */
export function filterHeaders(
  headers: Record<string, string>,
  extraSkip?: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "content-length" ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      extraSkip?.has(lower)
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}
