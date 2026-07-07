// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * `guardedFetch` — the single outbound-request primitive for any path whose
 * host comes from a less-trusted input (manifest URLs, OAuth endpoints,
 * webhook targets, configurable model/proxy base URLs, MCP discovery).
 *
 * Two SSRF guards historically coexisted in this codebase: the literal
 * `isBlockedUrl` (string-only, no DNS) and the DNS-rebind-safe
 * `resolveAndCheckHost`. Several outbound surfaces got only the literal guard —
 * or none — so a public hostname whose A record points at 169.254.169.254 (or
 * a `302` to such a name) sailed through. This helper closes that class:
 *
 * - Follows redirects MANUALLY (`redirect: "manual"`) so every hop is checked.
 * - Runs `resolveAndCheckHost` on the initial host AND on every redirect target
 *   (per-hop DNS resolution + blocklist), failing closed.
 * - Rejects non-http(s) schemes and strips userinfo/fragment from redirect
 *   targets (defeats `https://user:pass@…` credential-leak + fragment tricks).
 *
 * Residual: like the platform's other `fetch`-delegating guards, the OS
 * re-resolves the name when `fetch` actually connects, leaving a documented
 * narrow TOCTOU window. Consumers that own the socket (sidecar egress
 * listeners) pin `pinnedAddress` to fully close it; this primitive is for the
 * many `fetch`-based callers that cannot, and is strictly stronger than the
 * literal-only or unguarded status quo it replaces.
 *
 * Lives in the leaf `@appstrate/afps-shared` (re-exported by
 * `@appstrate/core/ssrf`) so the platform, sidecar, connect and the standalone
 * `afps` runtime can all share ONE implementation.
 */

import { resolveAndCheckHost, type HostResolver } from "./ssrf-dns.ts";

export interface GuardedFetchOptions {
  /** Max redirect hops to follow before giving up. Default 5. */
  maxRedirects?: number;
  /** Injectable resolver for tests. Production omits it. */
  resolve?: HostResolver;
  /** Structured logger for blocked/hop events. Values are never secrets. */
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

export class SsrfBlockedError extends Error {
  readonly reason: string;
  readonly host: string;
  constructor(host: string, reason: string) {
    super(`SSRF guard blocked outbound request to host "${host}" (${reason})`);
    this.name = "SsrfBlockedError";
    this.host = host;
    this.reason = reason;
  }
}

function assertHttp(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SsrfBlockedError(url.hostname || url.protocol, "non-http-scheme");
  }
}

function stripUserInfoAndFragment(url: URL): URL {
  const clean = new URL(url.toString());
  clean.username = "";
  clean.password = "";
  clean.hash = "";
  return clean;
}

async function checkHost(url: URL, opts?: GuardedFetchOptions): Promise<void> {
  const check = await resolveAndCheckHost(url.hostname, { resolve: opts?.resolve });
  if (check.blocked) {
    opts?.logger?.warn("guardedFetch blocked host", {
      host: url.hostname,
      reason: check.reason,
    });
    throw new SsrfBlockedError(url.hostname, check.reason);
  }
}

/**
 * SSRF-guarded `fetch` with per-hop DNS re-checking. Signature-compatible with
 * `fetch` for the common `(url, init)` call shape. Manual redirect handling
 * means any `init.redirect` is ignored (always treated as "manual" internally);
 * the returned `Response` is the first non-3xx response.
 */
export async function guardedFetch(
  input: string | URL,
  init?: RequestInit,
  opts?: GuardedFetchOptions,
): Promise<Response> {
  const maxRedirects = opts?.maxRedirects ?? 5;

  let current = stripUserInfoAndFragment(new URL(typeof input === "string" ? input : input.href));
  assertHttp(current);
  await checkHost(current, opts);

  let method = (init?.method ?? "GET").toUpperCase();
  let body = init?.body;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetch(current, { ...init, method, body, redirect: "manual" });

    // `fetch` reports opaqueredirect / 3xx: follow manually so each hop is guarded.
    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has("location");
    if (!isRedirect) return res;

    if (hop === maxRedirects) {
      throw new SsrfBlockedError(current.hostname, "too-many-redirects");
    }

    const location = res.headers.get("location")!;
    const next = stripUserInfoAndFragment(new URL(location, current));
    assertHttp(next);
    await checkHost(next, opts);

    // Standard redirect method/body rewriting: 303 (and 301/302 for POST per
    // browser convention) → GET with no body; 307/308 preserve method + body.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "HEAD")) {
      method = method === "HEAD" ? "HEAD" : "GET";
      body = undefined;
    }
    current = next;
    // Drain the redirect response body so the connection can be reused.
    await res.body?.cancel().catch(() => {});
  }

  // Unreachable — loop either returns or throws.
  throw new SsrfBlockedError(current.hostname, "redirect-loop");
}
