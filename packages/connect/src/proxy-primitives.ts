// SPDX-License-Identifier: Apache-2.0

/**
 * Shared primitives used by the credential-proxy server route
 * (`apps/api/src/routes/credential-proxy.ts`) and the in-container
 * sidecar (`runtime-pi/sidecar/app.ts`). Both code paths implement the
 * same wire protocol (X-Provider/X-Target/Set-Cookie passthrough) and
 * share the AFPS 1.3 spec-compliant URL allowlist matcher so drift is
 * impossible by construction.
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
 * AFPS 1.3 spec-compliant URL allowlist matcher. Re-exported from
 * `@appstrate/afps-runtime/resolvers` so the credential-proxy route,
 * the sidecar, and the in-bundle `provider-tool` all enforce the exact
 * same glob semantics by construction.
 */
export { matchesAuthorizedUriSpec } from "@appstrate/afps-runtime/resolvers";

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
