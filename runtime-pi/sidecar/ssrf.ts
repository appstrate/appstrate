// SPDX-License-Identifier: Apache-2.0

/**
 * Sidecar egress policy over `@appstrate/core/ssrf`: operator-trusted hosts, runner policy.
 */

import { isBlockedUrl } from "@appstrate/core/ssrf";
import {
  compileEgressPolicy,
  parseAuthorizedUriPattern,
} from "@appstrate/afps-shared/authorized-uris";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { isSelfHost, ownAddresses, type RunnerEgressPolicy } from "./helpers.ts";

/**
 * Whether `host` is in `trusted`, the `EGRESS_ALLOW_INTERNAL_HOSTS` set `parseSidecarEnv` parsed at
 * boot (empty exempts nothing). Who may skip the floor on these hosts:
 * docs/architecture/SIDECAR.md.
 */
export function isOperatorTrustedEgressHost(trusted: ReadonlySet<string>, host: string): boolean {
  return trusted.has(host.toLowerCase());
}

/** Literal check of an operator-configured URL (LLM baseUrl); trusted hosts skip the blocklist. */
export function isBlockedEgressUrl(url: string, trusted: ReadonlySet<string>): boolean {
  return isBlockedUrl(url, (host) => isOperatorTrustedEgressHost(trusted, host));
}

/**
 * A local runner's egress policy (rule: docs/architecture/SIDECAR.md). A runner gets raw TCP,
 * so no templated host or port may skip the floor.
 */
export function compileRunnerEgressPolicy(
  egress: NonNullable<IntegrationSpawnSpec["egress"]>,
  internalHost: (host: string) => boolean,
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
