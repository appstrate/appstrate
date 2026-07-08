// SPDX-License-Identifier: Apache-2.0

/**
 * SSRF protection — re-exported from `@appstrate/core/ssrf`.
 *
 * Single source of truth lives in `packages/core/src/ssrf.ts`. The
 * sidecar imports it via the same workspace channel it already uses
 * for `@appstrate/core/sidecar-types`, so `bun build --compile --minify`
 * tree-shakes the rest of core. Kept as a thin re-export module so
 * existing sidecar imports (`./ssrf.ts`) continue to resolve.
 */

import { isBlockedUrl } from "@appstrate/core/ssrf";

export { isBlockedHost, isBlockedUrl, resolveAndCheckHost } from "@appstrate/core/ssrf";
export type { HostResolver } from "@appstrate/core/ssrf";

/**
 * Operator-trusted internal egress hosts, injected by the platform as
 * `APPSTRATE_EGRESS_ALLOW_HOSTS` (comma-separated hostnames) when it spawns
 * the sidecar — derived from the platform's `OAUTH_ALLOWED_INTERNAL_IDP_HOSTS`
 * allowlist. The sidecar has no `@appstrate/env`/`@appstrate/connect` access,
 * so without this channel a host the operator explicitly trusts (an internal
 * model endpoint or remote MCP server on a private/Tailscale address) passes
 * the platform-side checks and then fails opaquely here at run time. Empty /
 * unset ⇒ nothing is exempt (the secure default).
 */
const trustedEgressHosts: ReadonlySet<string> = new Set(
  (process.env.APPSTRATE_EGRESS_ALLOW_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0),
);

export function isOperatorTrustedEgressHost(host: string): boolean {
  return trustedEgressHosts.has(host.toLowerCase());
}

/**
 * Allowlist-aware literal check for sidecar egress to an operator-configured
 * URL (LLM baseUrl). Parse/scheme stay fail-closed inside `isBlockedUrl`;
 * only the host blocklist is skipped for an operator-trusted host.
 */
export function isBlockedEgressUrl(url: string): boolean {
  return isBlockedUrl(url, isOperatorTrustedEgressHost);
}
