// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * `guardedFetch` — the single outbound-request primitive for any path whose
 * host comes from a less-trusted input (manifest URLs, OAuth endpoints,
 * webhook targets, configurable model/proxy base URLs, MCP discovery,
 * credential-proxy targets).
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
 * - CONNECTS TO THE VALIDATED ADDRESS: under Bun with the global `fetch`, each
 *   hop's request goes to the `pinnedAddress` returned by the guard (URL host
 *   rewritten to the resolved IP) while the logical `Host` header and the TLS
 *   SNI + certificate identity (`tls.serverName`) are preserved. The OS never
 *   re-resolves the name at connect time, so the classic check-then-fetch
 *   DNS-rebind TOCTOU is closed, not merely narrowed.
 *
 * The address pin falls back to a name-based connect (re-opening the
 * documented, narrow re-resolve TOCTOU — still guarded per hop) in exactly
 * these cases:
 * - a caller-injected `fetchImpl` (the seam owns its own transport; Bun's
 *   `tls`/URL-rewrite contract cannot be assumed),
 * - a non-Bun runtime (no `fetch` `tls.serverName` extension to preserve SNI —
 *   pinning without it would break certificate validation),
 * - an operator-trusted host via `allowHost` (blocklist and resolution are
 *   skipped by design, there is nothing to pin),
 * - an IP-literal URL (already its own pin; nothing to rebind).
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
   * that a bare `fetchImpl` call would lose. NOTE: an injected fetch disables
   * the address pin (see module doc) — the seam owns the connection.
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
  /**
   * Set to `false` to disable connecting to the DNS-validated address and
   * connect by name instead (per-hop guard still runs). Default: pin whenever
   * the runtime supports it. The only known reason to disable is an egress
   * HTTP proxy whose ACLs match on hostname rather than IP.
   */
  pinToResolvedAddress?: boolean;
  /** Structured logger for blocked/hop events. Values are never secrets. */
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Bun extends `fetch` with a per-request `tls` option (`serverName`,
 * `checkServerIdentity`, …). The address pin depends on `tls.serverName` to
 * keep SNI + certificate identity on the logical hostname while the TCP
 * connection goes to the pinned IP — without it, pinning an https URL would
 * fail certificate validation, so on other runtimes we fall back to a
 * name-based connect. Verified against Bun 1.3.x: `tls.serverName` drives
 * both the emitted SNI and the identity check (a mismatching serverName
 * fails with ERR_TLS_CERT_ALTNAME_INVALID).
 */
const runtimeSupportsFetchTls = (globalThis as { Bun?: unknown }).Bun !== undefined;

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

/**
 * Run the per-hop host guard. Returns the address the hop MUST connect to,
 * or `undefined` when there is nothing to pin (operator-trusted host).
 * Throws {@link SsrfBlockedError} on a blocked host (fail closed).
 */
async function checkHost(url: URL, opts?: GuardedFetchOptions): Promise<string | undefined> {
  if (opts?.allowHost?.(url.hostname)) return undefined; // operator-trusted host — skip blocklist
  const check = await resolveAndCheckHost(url.hostname, { resolve: opts?.resolve });
  if (check.blocked) {
    opts?.logger?.warn("guardedFetch blocked host", {
      host: url.hostname,
      reason: check.reason,
    });
    throw new SsrfBlockedError(url.hostname, check.reason);
  }
  return check.pinnedAddress;
}

/**
 * SSRF-guarded `fetch` with per-hop DNS re-checking and (under Bun) a real
 * connection pin to the validated address. Signature-compatible with `fetch`
 * for the common `(url, init)` call shape. Manual redirect handling means any
 * `init.redirect` is ignored (always treated as "manual" internally); the
 * returned `Response` is the first non-3xx response.
 */
export async function guardedFetch(
  input: string | URL,
  init?: RequestInit,
  opts?: GuardedFetchOptions,
): Promise<Response> {
  const maxRedirects = opts?.maxRedirects ?? 5;

  let current = stripUserInfoAndFragment(new URL(typeof input === "string" ? input : input.href));
  assertHttp(current);
  let pinnedAddress = await checkHost(current, opts);

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
  // A caller-supplied Host header is honoured only on the first, unpinned hop
  // (a virtual-host override for the URL the caller chose). On every later or
  // pinned hop the logical URL owns the Host value.
  const callerSetHost = headers.has("host");

  // The address pin requires owning the socket semantics: Bun's `fetch` `tls`
  // extension AND the global fetch (an injected transport seam cannot be
  // assumed to honour either the URL rewrite or the tls option).
  const pinningEnabled =
    runtimeSupportsFetchTls && !opts?.fetchImpl && opts?.pinToResolvedAddress !== false;
  const callerTls = (init as { tls?: Record<string, unknown> } | undefined)?.tls;

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
      // Pin the hop: connect to the validated address, keep the logical
      // hostname on the wire (`Host` header) and in the TLS handshake
      // (`tls.serverName` → SNI + certificate identity). `current` stays the
      // LOGICAL URL — redirect resolution and origin comparisons never see
      // the pinned form.
      const bareHost = current.hostname.replace(/^\[|\]$/g, "");
      const pin = pinnedAddress;
      const applyPin = pinningEnabled && pin !== undefined && pin !== bareHost;
      let requestUrl = current;
      let tlsOverride: Record<string, unknown> | undefined;
      if (applyPin) {
        requestUrl = new URL(current.toString());
        requestUrl.hostname = pin.includes(":") ? `[${pin}]` : pin;
        headers.set("host", current.host);
        if (current.protocol === "https:") {
          tlsOverride = { ...(callerTls ?? {}), serverName: current.hostname };
        }
      } else if (!(hop === 0 && callerSetHost)) {
        // Unpinned hop: let the runtime derive Host from the URL — a Host
        // value pinned for a previous hop must not leak onto this one.
        headers.delete("host");
      }

      const doFetch = opts?.fetchImpl ?? fetch;
      const res = await doFetch(requestUrl, {
        ...init,
        method,
        body,
        headers,
        signal,
        redirect: "manual",
        ...(tlsOverride ? { tls: tlsOverride } : {}),
      } as RequestInit);

      // `fetch` reports opaqueredirect / 3xx: follow manually so each hop is guarded.
      const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has("location");
      if (!isRedirect) return res;

      if (hop === maxRedirects) {
        throw new SsrfBlockedError(current.hostname, "too-many-redirects");
      }

      const location = res.headers.get("location")!;
      const next = stripUserInfoAndFragment(new URL(location, current));
      assertHttp(next);
      const nextPin = await checkHost(next, opts);

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
      pinnedAddress = nextPin;
      // Drain the redirect response body so the connection can be reused.
      await res.body?.cancel().catch(() => {});
    }
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }

  // Unreachable — loop either returns or throws.
  throw new SsrfBlockedError(current.hostname, "redirect-loop");
}
