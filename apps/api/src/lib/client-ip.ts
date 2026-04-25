// SPDX-License-Identifier: Apache-2.0

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

function pickFromXff(xff: string | null | undefined, hops: number): string | undefined {
  if (!xff || hops <= 0) return undefined;
  const parts = xff
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  const idx = parts.length - hops;
  return idx >= 0 ? parts[idx] : parts[0];
}

function resolveFromHeaders(headers: Headers): string | undefined {
  const hops = trustedHops();
  if (hops <= 0) return undefined;
  const fromXff = pickFromXff(headers.get("x-forwarded-for"), hops);
  if (fromXff) return fromXff;
  const real = headers.get("x-real-ip");
  if (real) return real;
  return undefined;
}

/**
 * Resolve the client IP from a Hono context.
 *
 * Honors `TRUST_PROXY` env var — set to `true`/`1` behind a single reverse
 * proxy, `N` behind N trusted hops, leave `false` for direct exposure.
 * When untrusted, `X-Forwarded-For`/`X-Real-IP` are ignored and the socket
 * remote address is returned.
 */
export function getClientIp(c: Context): string {
  const fromHeaders = resolveFromHeaders(c.req.raw.headers);
  if (fromHeaders) return fromHeaders;
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
 * Resolve the client IP from a raw `Request`. Used inside contexts that do
 * not own a Hono `Context` (e.g. Better Auth plugin hooks). Reads, in order:
 *   1. Trusted forwarded headers (`X-Forwarded-For`, `X-Real-IP`) per
 *      `TRUST_PROXY`.
 *   2. The per-Request IP map populated by `clientIpMiddleware` from
 *      `getConnInfo(c).remote.address`.
 *   3. `"unknown"` as last resort.
 */
export function getClientIpFromRequest(request: Request | undefined): string {
  if (!request) return "unknown";
  const fromHeaders = resolveFromHeaders(request.headers);
  if (fromHeaders) return fromHeaders;
  const fromStore = requestIpStore.get(request);
  if (fromStore) return fromStore;
  return "unknown";
}
