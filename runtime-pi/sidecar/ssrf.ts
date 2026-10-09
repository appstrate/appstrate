// SPDX-License-Identifier: Apache-2.0

/**
 * Sidecar egress policy over `@appstrate/core/ssrf`: the operator's trusted internal hosts and
 * a local runner's compiled egress policy.
 */

import { isBlockedUrl } from "@appstrate/core/ssrf";
import {
  compileEgressPolicy,
  parseAuthorizedUriPattern,
} from "@appstrate/afps-shared/authorized-uris";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { isLoopbackHost } from "@appstrate/afps-shared/ssrf";
import type { RunnerEgressPolicy } from "./helpers.ts";

/**
 * `EGRESS_ALLOW_INTERNAL_HOSTS` (comma-separated), forwarded by the platform; empty exempts
 * nothing. Operator-configured upstreams (LLM baseUrl, remote-MCP boot) skip the floor on them;
 * an `api_call` or a runner only on one the declared `authorized_uris` names literally.
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
 * A local runner's egress policy (#1458): it skips the SSRF floor only for a (host, port) a
 * declared entry names literally and the operator lists, never under `allow_all_uris`, never for
 * a loopback host (#1819). A runner gets raw TCP: no templated host or port may open one.
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
      !isLoopbackHost(host) &&
      internalHost(host) &&
      literal.allowsAuthority(host, port),
  };
}
