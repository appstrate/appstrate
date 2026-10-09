// SPDX-License-Identifier: Apache-2.0

/**
 * Sidecar egress policy on top of `@appstrate/core/ssrf`: the
 * operator-trusted-host allowlist, the allowlist-aware URL check and the
 * local runner's compiled egress policy.
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
import {
  compileEgressPolicy,
  parseAuthorizedUriPattern,
} from "@appstrate/afps-shared/authorized-uris";
import { skipsSsrfFloor } from "@appstrate/afps-runtime/resolvers";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import type { RunnerEgressPolicy } from "./helpers.ts";

/**
 * Operator-trusted internal egress hosts, forwarded by the platform as
 * `EGRESS_ALLOW_INTERNAL_HOSTS` (comma-separated hostnames) when it spawns the
 * sidecar. The sidecar has no `@appstrate/env`/`@appstrate/connect` access, so
 * without this channel a host the operator explicitly trusts (an internal model
 * endpoint or remote MCP server on a private/Tailscale address) passes the
 * platform-side checks and then fails opaquely here at run time. Empty / unset
 * ⇒ nothing is exempt (the secure default).
 *
 * Scope: operator-configured upstreams (LLM baseUrl, remote-MCP boot), and an
 * `api_call` or a runner listener only for a target the integration's declared
 * `authorized_uris` names literally ({@link compileRunnerEgressPolicy}).
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

/** A local runner's egress policy (#1458) with the `api_call` internal-host rule (#1819). */
export function compileRunnerEgressPolicy(
  egress: NonNullable<IntegrationSpawnSpec["egress"]>,
  internalHost: (host: string) => boolean = isOperatorTrustedEgressHost,
): RunnerEgressPolicy {
  // A runner gets raw TCP, so the exemption is per (host, port): a port a connection value or a
  // glob chose must not open an internal host's other services.
  const literal = compileEgressPolicy({
    authorizedUris: egress.declaredUris.filter((uri) => {
      const parsed = parseAuthorizedUriPattern(uri);
      return parsed.kind === "url" && !/[{*]/.test(parsed.authority);
    }),
    allowAllUris: false,
  });
  return {
    ...compileEgressPolicy(egress),
    skipsSsrfFloor: (host, port) =>
      literal.allowsAuthority(host, port) && skipsSsrfFloor(host, { ...egress, internalHost }),
  };
}
