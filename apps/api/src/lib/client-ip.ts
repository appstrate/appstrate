// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { getEnv } from "@appstrate/env";

const TRUSTED_HEADER = "x-appstrate-client-ip";

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

function socketAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address ?? undefined;
  } catch {
    return undefined;
  }
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
  const hops = trustedHops();
  if (hops > 0) {
    const fromXff = pickFromXff(c.req.header("x-forwarded-for"), hops);
    if (fromXff) return fromXff;
    const real = c.req.header("x-real-ip");
    if (real) return real;
  }
  return socketAddress(c) ?? "unknown";
}

/**
 * Resolve the client IP from a raw `Request`. Used inside contexts that do
 * not own a Hono `Context` (e.g. Better Auth plugin hooks). The outer
 * `/api/auth/*` mount stamps a `TRUSTED_HEADER` with the already-resolved
 * trusted IP so nested code does not need to re-parse `X-Forwarded-For`.
 */
export function getClientIpFromRequest(request: Request | undefined): string {
  if (!request) return "unknown";
  const stamped = request.headers.get(TRUSTED_HEADER);
  if (stamped) return stamped;
  const hops = trustedHops();
  if (hops > 0) {
    const fromXff = pickFromXff(request.headers.get("x-forwarded-for"), hops);
    if (fromXff) return fromXff;
    const real = request.headers.get("x-real-ip");
    if (real) return real;
  }
  return "unknown";
}

/**
 * Stamp a Request with the trusted client IP header for downstream code
 * that only has access to `Request` (Better Auth handler). Callers should
 * pass the result of `getClientIp(c)`.
 */
export function stampClientIp(request: Request, ip: string): Request {
  const headers = new Headers(request.headers);
  headers.set(TRUSTED_HEADER, ip);
  return new Request(request, { headers });
}

export { TRUSTED_HEADER as _TRUSTED_CLIENT_IP_HEADER };
