// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { getEnv } from "@appstrate/env";

// Per-Request IP store. The Hono `clientIpMiddleware` populates this map
// from `getConnInfo(c).remote.address` so the bare `Request` objects that
// propagate down to Better Auth plugin endpoints (which never receive the
// Hono `Context`) can still resolve the client IP without trusting
// `X-Forwarded-For`. WeakMap keys (Request instances) are GC'd with the
// request — no leak.
const requestIpStore = new WeakMap<Request, string>();

export function setRequestClientIp(request: Request, ip: string): void {
  if (!ip) return;
  requestIpStore.set(request, ip);
}

/**
 * Re-key the per-Request IP entry from `from` onto `to`. Used when an
 * intermediate handler (e.g. the device-flow form-body transformer in
 * `auth-pipeline.ts`) replaces `c.req.raw` with a freshly constructed
 * `Request` — without this propagation, downstream lookups by Request
 * identity miss and fall back to `null`.
 */
export function propagateRequestClientIp(from: Request, to: Request): void {
  if (from === to) return;
  const ip = requestIpStore.get(from);
  if (ip) requestIpStore.set(to, ip);
}

function parseTrustProxy(raw: string): number {
  if (raw === "false") return 0;
  if (raw === "true") return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

let _cachedHops: number | null = null;
function trustedHops(): number {
  if (_cachedHops === null) _cachedHops = parseTrustProxy(getEnv().TRUST_PROXY);
  return _cachedHops;
}

/** Test helper — drops cached TRUST_PROXY read between env mutations. */
export function resetClientIpCache(): void {
  _cachedHops = null;
}

/**
 * Reduce a forwarded entry to the bare IP address it names, or `undefined`
 * when it names none.
 *
 * Proxies disagree on the shape of one entry: most write a bare address,
 * Azure's front end appends `:port`, and some write IPv6 in brackets, with or
 * without a port. Those are three spellings of one address, so they normalize
 * to it; anything else — a hostname, `unknown`, an attacker-supplied string —
 * is not an address and is dropped rather than stamped.
 *
 * Dropping it is not hygiene. The resolved value travels to Better Auth on
 * {@link CLIENT_IP_HEADER}, and its `getIP` collapses every caller whose
 * address does not parse into ONE shared rate-limit bucket — so a single
 * caller sending `X-Forwarded-For: not-an-ip` would otherwise rate-limit the
 * whole instance.
 */
function normalizeForwardedIp(value: string): string | undefined {
  let v = value.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracketed) {
    v = bracketed[1]!;
  } else if (v.split(":").length === 2) {
    // Exactly one colon is `<ipv4>:<port>` — a bare IPv6 always carries more.
    v = v.slice(0, v.lastIndexOf(":"));
  }
  return isIP(v) === 0 ? undefined : v;
}

/**
 * The entry `hops` positions from the RIGHT of an `X-Forwarded-For` chain —
 * the last address a trusted proxy wrote, and the first one it did not.
 *
 * Counting from the right is what makes the pick unspoofable: every trusted
 * hop APPENDS the address it saw, so under `TRUST_PROXY=1` and
 * `X-Forwarded-For: <attacker text>, <real peer>` the rightmost entry — the
 * one our own proxy wrote — wins, and the attacker's prefix is inert.
 *
 * That holds only while the chain is at least as long as the hop count. A
 * SHORTER chain proves the trusted hops did not all append, which leaves every
 * entry in it caller-supplied, so this fails closed and returns `undefined`:
 * the caller falls back to the socket peer, the one address no header can
 * forge.
 */
function pickFromXff(xff: string, hops: number): string | undefined {
  const parts = xff
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < hops) return undefined;
  return normalizeForwardedIp(parts[parts.length - hops]!);
}

function resolveFromHeaders(headers: Headers): string | undefined {
  const hops = trustedHops();
  if (hops <= 0) return undefined;
  // A present `X-Forwarded-For` settles the question on its own: a proxy that
  // writes the chain writes it on every request, so a caller cannot strip it
  // to reach the `X-Real-IP` branch below. Where the chain is present but
  // untrustworthy, the whole forwarded set is — falling through to `X-Real-IP`
  // there would reopen the hole this closes.
  const xff = headers.get("x-forwarded-for");
  if (xff !== null) return pickFromXff(xff, hops);
  const real = headers.get("x-real-ip");
  return real ? normalizeForwardedIp(real) : undefined;
}

/**
 * Resolve the client IP from a Hono context.
 *
 * Honors `TRUST_PROXY` env var — set to `true`/`1` behind a single reverse
 * proxy, `N` behind N trusted hops, leave `false` for direct exposure.
 * When untrusted, `X-Forwarded-For`/`X-Real-IP` are ignored and the socket
 * remote address is returned. So are they when the forwarded chain is shorter
 * than the trusted hop count, or does not name an IP address at all — see
 * {@link pickFromXff}.
 */
export function getClientIp(c: Context): string {
  const fromHeaders = resolveFromHeaders(c.req.raw.headers);
  if (fromHeaders) return fromHeaders;
  // `middleware/client-ip.ts` already stored the socket address for this
  // Request; reading it back keeps `getConnInfo` to one call per request.
  const stored = requestIpStore.get(c.req.raw);
  if (stored) return stored;
  try {
    const fromConn = getConnInfo(c).remote.address;
    if (fromConn) {
      // Cache for downstream callers that only see the bare Request.
      setRequestClientIp(c.req.raw, fromConn);
      return fromConn;
    }
  } catch {
    // fall through
  }
  return "unknown";
}

/**
 * Header stating the platform-resolved client IP on the inbound `Request`.
 *
 * Better Auth resolves the address for its rate limiter and its session
 * tracking from headers alone, and the two trust models do not translate:
 * `TRUST_PROXY` is a hop COUNT, while `advanced.ipAddress.trustedProxies`
 * is a list of proxy addresses. So the platform resolves the address with
 * its own model and states it here, and Better Auth reads this header and
 * nothing else — it never walks a forwarded chain of its own.
 *
 * `middleware/client-ip.ts` is the one place that writes it, on the inbound
 * `Request` at the edge: every downstream reader — `getAuth().handler` and
 * every `getAuth().api.*` call handed `c.req.raw.headers` — inherits the
 * platform's answer, and a caller-supplied value never survives that far.
 */
export const CLIENT_IP_HEADER = "x-appstrate-client-ip";

/**
 * Resolve the client IP from a raw `Request`. Used inside contexts that do
 * not own a Hono `Context` (e.g. Better Auth plugin hooks). Reads, in order:
 *   1. Trusted forwarded headers (`X-Forwarded-For`, `X-Real-IP`) per
 *      `TRUST_PROXY`, skipped when the chain is too short to have been
 *      written by the trusted hops or the entry is not an IP address.
 *   2. The per-Request IP map populated by `clientIpMiddleware` from
 *      `getConnInfo(c).remote.address`.
 *   3. `null` when no source resolves an address. Callers that need a
 *      stable bucket key for grouping (e.g. IP-keyed rate limiters)
 *      substitute their own sentinel (`ip ?? "unknown"`); persistence
 *      callers (audit, dashboard) store NULL instead so the UI can
 *      render "—" without filtering a noise word.
 */
export function getClientIpFromRequest(request: Request | undefined): string | null {
  if (!request) return null;
  const fromHeaders = resolveFromHeaders(request.headers);
  if (fromHeaders) return fromHeaders;
  const fromStore = requestIpStore.get(request);
  if (fromStore) return fromStore;
  return null;
}
