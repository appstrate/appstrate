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
  /**
   * Deadline in ms covering the redirect chain up to the final response's
   * HEADERS, applied when the caller passes no `init.signal`. A hostile host
   * must not be able to hold a hop open indefinitely (slowloris) just because
   * a caller forgot a timeout, so the safe default lives in the primitive.
   * Consuming the returned body is NOT covered — the timer is detached once
   * the response is returned, so slow-but-healthy body reads are never
   * aborted. Default 30_000. Set to 0 to disable.
   */
  timeoutMs?: number;
  /** Injectable resolver for tests. Production omits it. */
  resolve?: HostResolver;
  /**
   * Injectable `fetch` for tests / callers that already own a transport seam
   * (e.g. `login-engine`'s `ctx.fetchImpl`). Production omits it and the global
   * `fetch` is used. Routing an injected fetch THROUGH this primitive keeps the
   * per-hop DNS guard, cross-origin credential/body stripping and scheme checks
   * that a bare `fetchImpl` call would lose.
   */
  fetchImpl?: typeof fetch;
  /**
   * Opt-in predicate for hosts the OPERATOR has explicitly trusted (e.g. an
   * internal IdP on a private address via `OAUTH_ALLOWED_INTERNAL_IDP_HOSTS`).
   * When it returns true the host blocklist is skipped for that hop, but the
   * manual-redirect discipline (cross-origin body/credential stripping) still
   * applies — so a trusted host that open-redirects cannot forward the secret.
   */
  allowHost?: (host: string) => boolean;
  /** Structured logger for blocked/hop events. Values are never secrets. */
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

const DEFAULT_TIMEOUT_MS = 30_000;

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
  if (opts?.allowHost?.(url.hostname)) return; // operator-trusted host — skip blocklist
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

  // Apply a default deadline when the caller supplied no signal of its own, so
  // a single hostile hop cannot hang forever. A caller-provided signal takes
  // precedence (it already encodes the caller's own timeout policy). The timer
  // is cleared once the final response's HEADERS have arrived — it must not
  // stay attached to the returned body stream, or a caller reading a slow but
  // healthy body past the deadline gets aborted mid-transfer.
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let signal = init?.signal ?? undefined;
  if (!signal && timeoutMs > 0) {
    const deadline = new AbortController();
    deadlineTimer = setTimeout(
      () =>
        deadline.abort(
          new DOMException(`guardedFetch deadline of ${timeoutMs}ms exceeded`, "TimeoutError"),
        ),
      timeoutMs,
    );
    signal = deadline.signal;
  }

  let method = (init?.method ?? "GET").toUpperCase();
  let body = init?.body;
  // Mutable header set for the chain. On a CROSS-ORIGIN redirect we drop the
  // credential headers (browser behaviour) so a `302 → other-host` cannot
  // forward the caller's `Authorization`/`Cookie` to a different origin — even
  // when that origin is a legitimate public host the SSRF host-check allows.
  const headers = new Headers(init?.headers ?? {});

  // Drop the request body and the headers that describe it — used both for
  // the standard 303/301/302 → GET rewrite and for the cross-host secret
  // containment below, so the two sites cannot drift (a body-less request
  // carrying a stale Content-Type/Content-Length confuses strict upstreams).
  const dropBody = () => {
    body = undefined;
    for (const h of ["content-type", "content-length", "content-encoding"]) headers.delete(h);
  };

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const doFetch = opts?.fetchImpl ?? fetch;
      const res = await doFetch(current, {
        ...init,
        method,
        body,
        headers,
        signal,
        redirect: "manual",
      });

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

      if (next.origin !== current.origin) {
        for (const h of ["authorization", "cookie", "proxy-authorization"]) headers.delete(h);
        // A 307/308 preserves method+body by spec, but re-sending a
        // secret-bearing request body (OAuth `client_secret`/`refresh_token`,
        // a signed webhook payload) to a DIFFERENT HOST is the same
        // credential-leak class as forwarding the `Authorization` header —
        // and header-stripping alone does not cover it. The boundary is the
        // HOST, not the origin: a same-host scheme/port upgrade (http→https
        // behind a TLS-terminating proxy — routine for allowlisted internal
        // IdPs) keeps the body, matching browser 307/308 behaviour; the one
        // same-host case still dropped is an https→http DOWNGRADE, which
        // would re-send the secret in cleartext.
        const schemeDowngrade = current.protocol === "https:" && next.protocol === "http:";
        if (body !== undefined && (next.hostname !== current.hostname || schemeDowngrade)) {
          opts?.logger?.warn("guardedFetch dropped request body on cross-host redirect", {
            status: res.status,
            fromHost: current.hostname,
            toHost: next.hostname,
            downgrade: schemeDowngrade,
          });
          dropBody();
        }
      }

      // Standard redirect method/body rewriting: 303 (and 301/302 for POST per
      // browser convention) → GET with no body; 307/308 preserve method + body
      // (already dropped above when crossing a host boundary).
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "HEAD")) {
        method = method === "HEAD" ? "HEAD" : "GET";
        dropBody();
      }
      current = next;
      // Drain the redirect response body so the connection can be reused.
      await res.body?.cancel().catch(() => {});
    }
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }

  // Unreachable — loop either returns or throws.
  throw new SsrfBlockedError(current.hostname, "redirect-loop");
}
