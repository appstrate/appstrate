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
 * Operator-trusted internal egress hosts, forwarded by the platform as
 * `EGRESS_ALLOW_INTERNAL_HOSTS` (comma-separated hostnames) when it spawns the
 * sidecar. The sidecar has no `@appstrate/env`/`@appstrate/connect` access, so
 * without this channel a host the operator explicitly trusts (an internal model
 * endpoint or remote MCP server on a private/Tailscale address) passes the
 * platform-side checks and then fails opaquely here at run time. Empty / unset
 * ⇒ nothing is exempt (the secure default).
 *
 * Scope is deliberate: this allowlist relaxes egress ONLY for operator-
 * configured upstreams — the LLM baseUrl gate (`/llm/*`) and the remote-MCP
 * client boot (`integrations-boot.ts`). It is intentionally NOT consulted by
 * the MITM / transparent / egress listeners, whose targets are agent- or
 * manifest-chosen rather than operator-trusted; relaxing the blocklist there
 * would let an agent-supplied URL reach an internal host the operator never
 * vouched for.
 */
const trustedEgressHosts: ReadonlySet<string> = new Set(
  (process.env.EGRESS_ALLOW_INTERNAL_HOSTS ?? "")
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
