// SPDX-License-Identifier: Apache-2.0

/**
 * Sidecar egress policy over `@appstrate/core/ssrf`: operator-trusted hosts, runner policy.
 */

import { isBlockedUrl } from "@appstrate/core/ssrf";
import { parseEgressAllowInternalHosts } from "@appstrate/afps-shared/ssrf";
import {
  compileEgressPolicy,
  parseAuthorizedUriPattern,
} from "@appstrate/afps-shared/authorized-uris";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { isSelfHost, ownAddresses, type RunnerEgressPolicy } from "./helpers.ts";

/**
 * `EGRESS_ALLOW_INTERNAL_HOSTS`; empty exempts nothing, and `parseSidecarEnv` refuses a malformed
 * entry at boot. Who may skip the floor on these hosts: docs/architecture/SIDECAR.md.
 */
const trustedEgressHosts = parseEgressAllowInternalHosts(
  process.env.EGRESS_ALLOW_INTERNAL_HOSTS,
).hosts;

export function isOperatorTrustedEgressHost(host: string): boolean {
  return trustedEgressHosts.has(host.toLowerCase());
}

/** Literal check of an operator-configured URL (LLM baseUrl); trusted hosts skip the blocklist. */
export function isBlockedEgressUrl(url: string): boolean {
  return isBlockedUrl(url, isOperatorTrustedEgressHost);
}

/**
 * A local runner's egress policy (rule: docs/architecture/SIDECAR.md). A runner gets raw TCP,
 * so no templated host or port may skip the floor.
 */
export function compileRunnerEgressPolicy(
  egress: NonNullable<IntegrationSpawnSpec["egress"]>,
  internalHost: (host: string) => boolean = isOperatorTrustedEgressHost,
  addresses: () => ReadonlySet<string> = ownAddresses,
): RunnerEgressPolicy {
  const isSelf = (host: string) => isSelfHost(host, addresses);
  const literal = compileEgressPolicy({
    authorizedUris: egress.declaredUris.filter((uri) => {
      const parsed = parseAuthorizedUriPattern(uri);
      return parsed.kind === "url" && !/[{*]/.test(parsed.authority);
    }),
    allowAllUris: false,
  });
  return {
    ...compileEgressPolicy(egress),
    isSelf,
    skipsSsrfFloor: (host, port) =>
      !egress.allowAllUris &&
      !isSelf(host) &&
      internalHost(host) &&
      literal.allowsAuthority(host, port),
  };
}
