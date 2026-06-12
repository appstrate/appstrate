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
 * The resolution layer itself lives in `@appstrate/core/ssrf`
 * (`resolveAndCheckHost`) and is shared with the sidecar egress listeners.
 * This wrapper keeps the URL-shaped API and platform logging: it resolves
 * every A/AAAA record and blocks if ANY resolves into a private/internal
 * range, failing closed on any resolution error (an attacker who can make
 * resolution fail must not thereby bypass the check).
 *
 * Residual TOCTOU: the actual connection (made by the caller / the upstream
 * plugin) re-resolves, so a hostile resolver could return a public IP here and
 * an internal one at connect time. Closing that fully requires resolve-then-
 * connect-to-pinned-IP, which the runtime-agnostic upstream plugin does not
 * expose. This guard is therefore defence-in-depth that raises the bar
 * substantially over the literal-only check; it is not a complete pin. The
 * platform host denylist (`isBlockedUrl`) still runs first and unconditionally.
 */

import { isBlockedUrl, resolveAndCheckHost, type HostResolver } from "@appstrate/core/ssrf";
import { logger } from "./logger.ts";

export type { HostResolver } from "@appstrate/core/ssrf";

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

  const check = await resolveAndCheckHost(hostname, { resolve: deps?.resolve });
  if (check.blocked && check.reason === "resolution-failed") {
    logger.debug("ssrf-dns: resolution failed — blocking", {
      hostname,
      error: check.detail ?? "unknown",
    });
  }
  return check.blocked;
}
