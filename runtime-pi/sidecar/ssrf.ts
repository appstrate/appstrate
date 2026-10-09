// SPDX-License-Identifier: Apache-2.0

/**
 * Sidecar egress policy on top of `@appstrate/core/ssrf`: the operator-trusted-host
 * allowlist, the allowlist-aware URL check and a local runner's compiled egress policy.
 * The base primitives are imported from `@appstrate/core/ssrf` through `./helpers.ts`.
 */

import { isBlockedUrl } from "@appstrate/core/ssrf";
import {
  compileEgressPolicy,
  parseAuthorizedUriPattern,
} from "@appstrate/afps-shared/authorized-uris";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { isLoopback, type RunnerEgressPolicy } from "./helpers.ts";

/**
 * Operator-trusted internal hosts, `EGRESS_ALLOW_INTERNAL_HOSTS` (comma-separated), forwarded
 * by the platform. Empty ⇒ nothing is exempt. They relax the floor for operator-configured
 * upstreams (LLM baseUrl, remote-MCP boot), and for an `api_call` or a runner listener only on
 * a target the integration's declared `authorized_uris` names literally.
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

/** Literal check of an operator-configured URL (LLM baseUrl); trusted hosts skip the blocklist. */
export function isBlockedEgressUrl(url: string): boolean {
  return isBlockedUrl(url, isOperatorTrustedEgressHost);
}

/**
 * A local runner's egress policy (#1458). It skips the SSRF floor only for a (host, port) a
 * declared entry names literally and the operator lists, never under `allow_all_uris`, never
 * for this machine (#1819): a runner gets raw TCP, so a port or a host a connection value or a
 * glob chose must not open an internal host's other services.
 */
export function compileRunnerEgressPolicy(
  egress: NonNullable<IntegrationSpawnSpec["egress"]>,
  internalHost: (host: string) => boolean = isOperatorTrustedEgressHost,
): RunnerEgressPolicy {
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
      !egress.allowAllUris &&
      !isLoopback(host) &&
      internalHost(host) &&
      literal.allowsAuthority(host, port),
  };
}
