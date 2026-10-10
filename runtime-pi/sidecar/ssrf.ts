// SPDX-License-Identifier: Apache-2.0

/**
 * Sidecar egress policy over `@appstrate/core/ssrf`: operator-trusted hosts, runner policy.
 */

import { isBlockedUrl } from "@appstrate/core/ssrf";
import {
  compileEgressPolicy,
  parseAuthorizedUriPattern,
} from "@appstrate/afps-shared/authorized-uris";
import { parseEgressAllowInternalHosts } from "@appstrate/afps-shared/ssrf";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { isSelfHost, ownAddresses, type RunnerEgressPolicy } from "./helpers.ts";

/**
 * `EGRESS_ALLOW_INTERNAL_HOSTS` (comma-separated); empty exempts nothing. Who may skip the floor
 * on these hosts: docs/architecture/SIDECAR.md. Validated at boot by parseSidecarEnv; same parser
 * as the platform.
 */
let trustedEgressHosts: ReadonlySet<string> | undefined;

function trustedEgressHostSet(): ReadonlySet<string> {
  if (trustedEgressHosts === undefined) {
    const { hosts, invalid } = parseEgressAllowInternalHosts(
      process.env.EGRESS_ALLOW_INTERNAL_HOSTS,
    );
    if (invalid.length > 0) throw new Error(`EGRESS_ALLOW_INTERNAL_HOSTS: ${invalid.join("; ")}`);
    trustedEgressHosts = hosts;
  }
  return trustedEgressHosts;
}

export function isOperatorTrustedEgressHost(host: string): boolean {
  return trustedEgressHostSet().has(host.toLowerCase());
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
