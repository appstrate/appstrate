// SPDX-License-Identifier: Apache-2.0

/**
 * DNS-resolving SSRF guard for server-initiated outbound fetches.
 *
 * `@appstrate/core/ssrf` (`isBlockedUrl`/`isBlockedHost`) is a LITERAL check:
 * it normalises and blocks IP-literal and known-internal hostnames, but does
 * NOT resolve DNS — so `https://evil.example/doc` whose A record points at
 * `169.254.169.254` or an RFC 1918 address passes it. For a fetch the platform
 * initiates against a client-controlled URL (the CIMD metadata-document fetch
 * is the only caller today), that residual rebinding-to-internal vector matters.
 *
 * This guard layers DNS resolution on top: it resolves every A/AAAA record and
 * blocks if ANY resolves into a private/internal range. It fails closed on any
 * resolution error (an attacker who can make resolution fail must not thereby
 * bypass the check).
 *
 * Residual TOCTOU: the actual connection (made by the caller / the upstream
 * plugin) re-resolves, so a hostile resolver could return a public IP here and
 * an internal one at connect time. Closing that fully requires resolve-then-
 * connect-to-pinned-IP, which the runtime-agnostic upstream plugin does not
 * expose. This guard is therefore defence-in-depth that raises the bar
 * substantially over the literal-only check; it is not a complete pin. The
 * platform host denylist (`isBlockedUrl`) still runs first and unconditionally.
 */

import { lookup } from "node:dns/promises";
import { isBlockedUrl, isBlockedHost } from "@appstrate/core/ssrf";
import { logger } from "./logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";

/**
 * Resolve a hostname to its IP addresses. Injectable so tests can exercise the
 * resolution branch deterministically without real DNS. Production uses
 * `node:dns/promises` `lookup` (honours the system resolver + `/etc/hosts`).
 */
export type HostResolver = (hostname: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
};

/**
 * True if `url` should be blocked — either by the literal denylist or because
 * its hostname resolves to a private/internal address. Never throws; any
 * failure path returns `true` (fail closed).
 *
 * `deps.resolve` injects a resolver for tests; production callers pass nothing.
 */
export async function isBlockedUrlWithDns(
  url: string,
  deps?: { resolve?: HostResolver },
): Promise<boolean> {
  // Literal check first: protocol, IP-literals, known-internal hostnames.
  if (isBlockedUrl(url)) return true;

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return true;
  }

  const resolve = deps?.resolve ?? defaultResolver;
  try {
    const addresses = await resolve(hostname);
    if (addresses.length === 0) return true; // no address → nothing legitimate to reach
    return addresses.some((addr) => isBlockedHost(addr));
  } catch (err) {
    logger.debug("ssrf-dns: resolution failed — blocking", {
      hostname,
      error: getErrorMessage(err),
    });
    return true;
  }
}
