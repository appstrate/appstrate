// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * DNS-resolving layer over the literal SSRF blocklist (`./ssrf`).
 *
 * `isBlockedHost` alone is literal-only: a DNS name whose A/AAAA record
 * points at an internal address (10.x, 169.254.169.254, …) passes it, and
 * a consumer that re-resolves the name at connect time is open to a
 * DNS-rebind bypass. Consumers that control the connection close that gap
 * fully by connecting to the returned `pinnedAddress`: sidecar egress
 * listeners own the raw socket, and `guardedFetch` (./guarded-fetch.ts)
 * rewrites the request URL to the pin while preserving Host + TLS SNI
 * (Bun). A consumer that instead delegates the connection to a plain
 * name-based `fetch` only gets fail-closed defence-in-depth with a
 * residual re-resolve TOCTOU — prefer `guardedFetch`.
 *
 * Kept in its own subpath (not `./ssrf`) so the literal module stays free
 * of node builtins — this module needs `node:dns` + `node:net` and is
 * server-side only. Re-exported verbatim by `@appstrate/core/ssrf` and
 * consumed directly by `@appstrate/afps-runtime` (which cannot depend on
 * core — it ships standalone with the `afps` CLI).
 */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { isBlockedHost } from "./ssrf.ts";

/**
 * Resolve a hostname to its IP addresses. Injectable so tests can exercise
 * the resolution branch deterministically without real DNS. Production uses
 * `node:dns/promises` `lookup` (honours the system resolver + `/etc/hosts`).
 */
export type HostResolver = (hostname: string) => Promise<string[]>;

export const defaultHostResolver: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
};

export type ResolvedHostCheck =
  | { blocked: false; pinnedAddress: string }
  | {
      blocked: true;
      reason: "blocked-literal" | "blocked-resolved" | "resolution-failed";
      /** Human-readable detail for logs (resolution error message). Never a secret. */
      detail?: string;
    };

/**
 * DNS-rebind-safe host check. Never throws; fails closed.
 *
 * - IP literals: checked against the literal blocklist, returned as their own
 *   `pinnedAddress` (no DNS round-trip).
 * - DNS names: literal blocklist first (known-internal names), then EVERY
 *   resolved A/AAAA record is checked — if ANY lands in a blocked range, or
 *   resolution fails / returns nothing, the host is refused.
 * - On success, `pinnedAddress` is one resolved address (IPv4 preferred) the
 *   caller MUST connect to directly — connecting by name would re-resolve and
 *   reopen the rebind window.
 *
 * `deps.resolve` injects a resolver for tests; `deps.isBlockedHostFn` lets
 * callers that already take an injectable blocklist predicate thread it
 * through. Production callers pass neither.
 */
export async function resolveAndCheckHost(
  host: string,
  deps?: { resolve?: HostResolver; isBlockedHostFn?: typeof isBlockedHost },
): Promise<ResolvedHostCheck> {
  const isBlockedHostFn = deps?.isBlockedHostFn ?? isBlockedHost;
  // `URL.hostname` / CONNECT targets may carry IPv6 brackets — strip for
  // uniform handling (`isBlockedHost` normalizes internally either way).
  const bare = host.replace(/^\[|\]$/g, "");

  // Literal floor — IP literals and known-internal hostnames.
  if (isBlockedHostFn(bare)) return { blocked: true, reason: "blocked-literal" };

  // IP literal: nothing to resolve — pin the literal itself.
  if (isIP(bare) !== 0) return { blocked: false, pinnedAddress: bare };

  const resolve = deps?.resolve ?? defaultHostResolver;
  let addresses: string[];
  try {
    addresses = await resolve(bare);
  } catch (err) {
    return {
      blocked: true,
      reason: "resolution-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (addresses.length === 0) {
    // No address → nothing legitimate to reach (fail closed).
    return { blocked: true, reason: "resolution-failed", detail: "no addresses resolved" };
  }
  if (addresses.some((addr) => isBlockedHostFn(addr))) {
    return { blocked: true, reason: "blocked-resolved" };
  }
  // Prefer an IPv4 answer for the pin — pinning a AAAA record on a host
  // without IPv6 egress would regress connectivity that name-based connects
  // (which try both families) used to have.
  const pinnedAddress = addresses.find((addr) => isIP(addr) === 4) ?? addresses[0]!;
  return { blocked: false, pinnedAddress };
}
