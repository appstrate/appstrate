// SPDX-License-Identifier: Apache-2.0

/**
 * Sidecar egress policy on top of `@appstrate/core/ssrf`: the
 * operator-trusted-host allowlist and the allowlist-aware URL check.
 *
 * The base primitives (`isBlockedHost`, `isBlockedUrl`,
 * `resolveAndCheckHost`, `HostResolver`) are NOT re-exported from here.
 * They used to be, purely so `helpers.ts` could re-export them a second
 * time — no consumer ever imported them from this module, and every real
 * consumer goes through `./helpers.ts`, which now reaches
 * `@appstrate/core/ssrf` directly. One hop instead of two, and this file
 * is left holding only what it actually adds.
 */

import { isBlockedUrl } from "@appstrate/core/ssrf";

/**
 * Operator-trusted internal egress hosts, forwarded by the platform as
 * `EGRESS_ALLOW_INTERNAL_HOSTS` (comma-separated hostnames) when it spawns the
 * sidecar. The sidecar has no `@appstrate/env`/`@appstrate/connect` access, so
 * without this channel a host the operator explicitly trusts (an internal model
 * endpoint or remote MCP server on a private/Tailscale address) passes the
 * platform-side checks and then fails opaquely here at run time. Empty / unset
 * ⇒ nothing is exempt (the secure default).
 *
 * Scope is deliberate: this allowlist relaxes egress for operator-configured
 * upstreams — the LLM baseUrl gate (`/llm/*`) and the remote-MCP client boot
 * (`integrations-boot.ts`) — and for an `api_call` target (`credential-proxy.ts`),
 * as on the platform credential proxy. It is intentionally NOT consulted by
 * the MITM / transparent / egress listeners, which a runner drives directly.
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
