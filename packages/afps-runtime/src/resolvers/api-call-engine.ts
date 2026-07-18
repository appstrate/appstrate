// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Shared outbound-HTTP engine for credential-injecting integration calls.
 *
 * This module owns the credential-source-agnostic, security-critical
 * request pipeline that EVERY surface making a direct upstream call must
 * share:
 *
 *   1. `authorized_uris` allowlist preflight on the initial target.
 *   2. SSRF blocklist preflight (loopback / RFC1918 / link-local / cloud
 *      metadata) — applied even when no allowlist is declared.
 *   3. A manual redirect-follower that, for EVERY hop:
 *        - re-checks the SSRF blocklist (a compromised upstream cannot
 *          pivot the proxy to `http://169.254.169.254/...`),
 *        - re-checks the declared `authorized_uris` allowlist,
 *        - strips userinfo + fragment from the `Location` before policy
 *          checks and before re-issuing the fetch,
 *        - applies a hybrid credential-strip (forward credentials inside
 *          a declared allowlist; WHATWG origin-based strip otherwise),
 *        - captures `Set-Cookie` from intermediate hops into a jar
 *          (Bun/Node native fetch only surface the final hop's cookies).
 *
 * What this module deliberately does NOT own:
 *   - HOW credentials are obtained (the sidecar fetches them from the
 *     platform; the local CLI resolver reads a local creds file). Callers
 *     inject the resolved headers BEFORE calling {@link fetchWithGuards}.
 *   - Response serialisation (the sidecar spills to its MCP BlobStore;
 *     the CLI resolver spills to a workspace file). Those are
 *     surface-specific and stay in their respective modules.
 *
 * The two consumers are:
 *   - `runtime-pi/sidecar/credential-proxy.ts` (`executeApiCall`) — the
 *     platform/container path. Its redirect-chain tests in
 *     `runtime-pi/sidecar/test/credential-proxy.test.ts` are the
 *     correctness oracle for the follower in this module.
 *   - `packages/afps-runtime/src/resolvers/integration-api-call.ts`
 *     (`LocalIntegrationResolver`) — the standalone `afps` CLI path. It
 *     previously did a raw `fetch(target, …)` with default
 *     `redirect: "follow"` and NO SSRF check; routing it through this
 *     engine closes that gap.
 *
 * It lives in `@appstrate/afps-runtime` (not `@appstrate/connect`) because
 * the dependency edge runs `connect → afps-runtime`; the CLI path cannot
 * import `@appstrate/connect` without a cycle. The sidecar already depends
 * on `@appstrate/afps-runtime`, so both consumers reach this module freely.
 */

import { isBlockedUrl } from "@appstrate/afps-shared/ssrf";
import { resolveAndCheckHost, type HostResolver } from "@appstrate/afps-shared/ssrf-dns";
import { matchesAuthorizedUriSpec } from "./http-call-core.ts";

export type { HostResolver } from "@appstrate/afps-shared/ssrf-dns";

/** Maximum redirect hops the follower will chase before giving up. */
export const MAX_REDIRECTS = 10;

/**
 * Check a target URL against a list of `authorized_uris` patterns using
 * the AFPS spec semantics (`*` matches a single path segment, `**` matches
 * any substring). Thin `(url, patterns[])` wrapper over
 * {@link matchesAuthorizedUriSpec} — used both for the initial preflight
 * and for per-hop redirect re-checks.
 */
export function matchesAuthorizedUri(url: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesAuthorizedUriSpec(p, url));
}

/**
 * Strip userinfo (`user:pass@`) and fragment (`#…`) from a URL. Mirrors
 * WHATWG Fetch `Response.url` sanitisation. Used on every redirect hop
 * before policy checks / re-fetch (block attacker-injected basic-auth,
 * keep the allowlist matcher host-based) and on the `finalUrl` envelope
 * field (no credential or implicit-flow-fragment leakage to agents).
 * Returns `undefined` on parse failure so callers can omit the field.
 */
export function stripUserInfoAndFragment(url: string): string | undefined {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    u.hash = "";
    return u.toString();
  } catch {
    return undefined;
  }
}

/**
 * Per-hop redirect refusal. The host is exposed for logs only — a
 * redirect target may itself encode capabilities (`?token=…`) we don't
 * want surfaced verbatim. Callers map this to a 403 (policy decision),
 * distinct from the 502 reserved for network faults.
 */
export class RedirectBlockedError extends Error {
  constructor(
    public readonly reason: "ssrf" | "unauthorized",
    public readonly hopUrl: string,
  ) {
    super(`Redirect blocked (${reason})`);
    this.name = "RedirectBlockedError";
  }
}

/**
 * Result of {@link preflightUrl}. `{ ok: true }` clears the request to
 * proceed; `{ ok: false }` carries a structured rejection the caller maps
 * to its own error shape (sidecar `{status,error}` failure, CLI
 * `AuthorizedUrisError` / SSRF error).
 */
export type PreflightResult =
  { ok: true } | { ok: false; reason: "ssrf" | "not_authorized"; message: string };

export interface PreflightOptions {
  /**
   * Provider's declared trust boundary. When non-empty and `allowAllUris`
   * is false, the target must match.
   */
  authorizedUris?: string[] | null;
  /**
   * When true, the allowlist gate is skipped — but the SSRF blocklist
   * still applies (no `allowAllUris` ever permits a loopback / RFC1918 /
   * metadata target).
   */
  allowAllUris?: boolean;
  /**
   * DNS resolver for the SSRF rebind check — injectable for tests.
   * Production callers omit it (system resolver via `node:dns`).
   */
  resolveHost?: HostResolver;
}

/**
 * True when some allowlist entry names the URL's host with a literal
 * (wildcard-free) host component. Only then is the allowlist a
 * host-level trust declaration that exempts the target from the SSRF
 * gate: the operator wrote that exact host down, so an internal address
 * behind it is their declared topology (on-prem APIs are legitimate
 * allowlist targets). Entries whose host segment contains a glob
 * (`https://**`, `https://*.example.com/…`) never pin — the concrete
 * host is then chosen by the agent at call time, and the SSRF gate must
 * still apply.
 *
 * The host comparison is authority-only and case-insensitive: userinfo
 * and the port are stripped, a globbed scheme (`**://`, `*://`) and a
 * globbed port (`:*`) are tolerated — a glob there doesn't make the HOST
 * agent-chosen, and refusing to pin would wrongly re-gate a literal
 * on-prem host the operator explicitly named.
 */
export function hostLiterallyAllowlisted(url: string, specs: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const spec of specs) {
    const m = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*|\*{1,2}):\/\/([^/?#]+)/.exec(spec.trim());
    if (!m) continue;
    const hostPart = m[1]!.replace(/^[^@]*@/, "").replace(/:(\d+|\*)$/, "");
    if (hostPart.includes("*")) continue;
    if (hostPart.toLowerCase() === host) return true;
  }
  return false;
}

/**
 * SSRF gate shared by every preflight branch without a literal operator
 * host pin: the literal blocklist first (IP literals, known-internal
 * names), then resolve every A/AAAA record and refuse if ANY lands in a
 * blocked range (fail closed on resolution failure). A DNS name whose
 * record points inside (10.x, 169.254.169.254, …) passes `isBlockedUrl`
 * alone — this closes the rebind-to-internal vector. The connection is
 * delegated to `fetch`, which re-resolves, so this is fail-closed
 * defence-in-depth with a documented residual TOCTOU, not a full
 * resolve-and-pin.
 */
async function refuseSsrfUrl(url: string, resolveHost?: HostResolver): Promise<PreflightResult> {
  const blocked: PreflightResult = {
    ok: false,
    reason: "ssrf",
    message: "URL targets a blocked network range",
  };
  if (isBlockedUrl(url)) return blocked;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return blocked;
  }
  const check = await resolveAndCheckHost(hostname, { resolve: resolveHost });
  if (!check.blocked) return { ok: true };
  if (check.reason === "resolution-failed") {
    return {
      ok: false,
      reason: "ssrf",
      message: `Target host could not be resolved (${redactHost(url)})`,
    };
  }
  return blocked;
}

/**
 * Validate the INITIAL target URL against the allowlist + SSRF blocklist
 * + DNS-rebind layer. Mirrors the sidecar's `executeApiCall` branches:
 *   - `allowAllUris` → SSRF safety-net (literal + DNS).
 *   - declared `authorizedUris` → must match; a glob-matched host (no
 *     literal pin) additionally passes the SSRF safety-net — `https://**`
 *     would otherwise let the agent pick ANY host with zero floor,
 *     strictly weaker than allow_all.
 *   - neither → SSRF safety-net (no allowlist means "block internals").
 *
 * The per-hop equivalents live in {@link fetchFollowingRedirectsCapturingCookies}.
 */
export async function preflightUrl(url: string, opts: PreflightOptions): Promise<PreflightResult> {
  const authorizedUris = opts.authorizedUris ?? undefined;
  if (opts.allowAllUris) {
    return refuseSsrfUrl(url, opts.resolveHost);
  }
  if (authorizedUris && authorizedUris.length) {
    if (!matchesAuthorizedUri(url, authorizedUris)) {
      return {
        ok: false,
        reason: "not_authorized",
        message: `URL not in authorized_uris allowlist. Allowed: ${authorizedUris.join(", ")}`,
      };
    }
    if (!hostLiterallyAllowlisted(url, authorizedUris)) {
      return refuseSsrfUrl(url, opts.resolveHost);
    }
    return { ok: true };
  }
  // No authorized_uris and no allowAllUris — apply the SSRF safety net.
  return refuseSsrfUrl(url, opts.resolveHost);
}

/** Extract hostname for audit logs, never throwing. */
export function redactHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "<unparseable>";
  }
}

/** Dedup by cookie name; strip attributes (Path, Expires, Domain, SameSite, …). */
export function mergeSetCookieIntoJar(
  setCookieHeaders: string[],
  cookieJar: Map<string, string[]>,
  integrationId: string,
): void {
  if (!setCookieHeaders.length) return;
  const byName = new Map<string, string>();
  for (const ck of cookieJar.get(integrationId) ?? []) byName.set(ck.split("=")[0]!, ck);
  for (const h of setCookieHeaders) {
    const ck = h.split(";")[0]!.trim();
    byName.set(ck.split("=")[0]!, ck);
  }
  cookieJar.set(integrationId, [...byName.values()]);
}

/** Parse a `Cookie:` header value into name→pair entries, deduped by name. */
function parseCookieHeader(value: string | null): Map<string, string> {
  const byName = new Map<string, string>();
  if (!value) return byName;
  for (const part of value.split(";")) {
    const trimmed = part.trim();
    if (trimmed) byName.set(trimmed.split("=")[0]!, trimmed);
  }
  return byName;
}

/** Optional observability hook — callers pass a logger; defaults to no-op. */
export interface RedirectLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

const NOOP_LOGGER: RedirectLogger = { warn() {} };

export interface RedirectFollowOptions {
  url: string;
  init: RequestInit;
  fetchFn: typeof fetch;
  cookieJar: Map<string, string[]>;
  integrationId: string;
  /** Lowercased name of the credential header server-injected by the caller. */
  injectedCredentialHeader: string | null;
  /**
   * Provider's declared trust boundary. Each candidate redirect hop is
   * checked against this allowlist; off-allowlist hops throw
   * {@link RedirectBlockedError} instead of being followed. Empty or
   * undefined → no allowlist gate, origin-based credential strip applies
   * (mirroring WHATWG fetch).
   */
  authorizedUris?: string[];
  /**
   * When true, every URL matches the "allowlist" — the per-hop allowlist
   * gate is bypassed and credential strip falls back to origin equality.
   * The per-hop SSRF blocklist still applies (no `allowAllUris` ever lets
   * a redirect target reach loopback / RFC1918).
   */
  allowAllUris?: boolean;
  /** Optional logger for per-hop refusals. Defaults to a no-op. */
  logger?: RedirectLogger;
  /**
   * DNS resolver for the per-hop SSRF rebind check — injectable for tests.
   * Production callers omit it (system resolver via `node:dns`).
   */
  resolveHost?: HostResolver;
}

/**
 * Manually follow 3xx redirects so we can capture `Set-Cookie` from
 * **every** hop into the per-integration jar — Bun's / undici's native
 * fetch only surfaces the final hop's `Set-Cookie`, which breaks
 * multi-step OAuth/CAS flows where the session cookie lands on an
 * intermediate 302 (see #473).
 *
 * Defence-in-depth for redirect chains (see #475):
 *
 *   - **Per-hop SSRF blocklist** — every candidate hop is checked against
 *     `isBlockedUrl` (loopback, RFC1918, link-local, cloud metadata)
 *     regardless of `allowAllUris`.
 *   - **Per-hop allowlist** — when the integration declared
 *     `authorizedUris`, every hop must match. Off-allowlist redirects are
 *     refused with a {@link RedirectBlockedError} rather than silently
 *     followed into attacker-controlled hosts.
 *   - **Hybrid credential strip** — when an allowlist is declared,
 *     surviving hops are inside the trust boundary by construction so
 *     credentials are forwarded (lets multi-host APIs like Dropbox
 *     `api.dropboxapi.com` ⇄ `content.dropboxapi.com` work). With
 *     `allowAllUris: true` (no declared boundary) we fall back to
 *     WHATWG-style origin-based strip.
 *
 * Streaming bodies must skip this path entirely (caller falls back to
 * native fetch — bodies can't be replayed across hops). The initial-URL
 * allowlist check still bounds the SSRF surface for that path.
 *
 * Caller-supplied cookies are preserved across hops (the jar wins on name
 * conflict so server-rotated values replace stale caller-supplied ones).
 *
 * Returns the terminal `Response`, the URL it was served from (so
 * callers driving redirect-chain flows — OAuth code, CAS ticket,
 * magic-link — can extract callback query params without parsing
 * bodies, see #471), and `hops`: the number of redirects followed
 * (`0` when the first response was terminal). The hop count is surfaced
 * for operator diagnostics (see #404) so a debug log can distinguish a
 * clean call from one that bounced through a redirect chain.
 */
export async function fetchFollowingRedirectsCapturingCookies(
  opts: RedirectFollowOptions,
): Promise<{ response: Response; finalUrl: string; hops: number }> {
  const {
    url,
    init,
    fetchFn,
    cookieJar,
    integrationId,
    injectedCredentialHeader,
    authorizedUris,
    allowAllUris,
  } = opts;
  const logger = opts.logger ?? NOOP_LOGGER;
  const hasAllowlist = !!authorizedUris && authorizedUris.length > 0;
  const callerCookies = parseCookieHeader(
    new Headers(init.headers as RequestInit["headers"]).get("cookie"),
  );

  let currentUrl = url;
  let currentInit: RequestInit = { ...init, redirect: "manual" };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchFn(currentUrl, currentInit);
    mergeSetCookieIntoJar(response.headers.getSetCookie(), cookieJar, integrationId);

    if (response.status < 300 || response.status >= 400) {
      return { response, finalUrl: currentUrl, hops: hop };
    }
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: currentUrl, hops: hop };

    // Per WHATWG fetch (HTTP-redirect fetch step 11) + RFC 9110 §15.4:
    //   - 301/302 downgrade POST → GET (other methods preserved)
    //   - 303     downgrade everything-except-GET/HEAD → GET (HEAD preserved)
    //   - 307/308 preserve method + body verbatim
    const method = (currentInit.method ?? "GET").toUpperCase();
    const dropBody =
      ((response.status === 301 || response.status === 302) && method === "POST") ||
      (response.status === 303 && method !== "GET" && method !== "HEAD");
    // Resolve, then strip userinfo + fragment. Userinfo in a Location
    // would arrive as basic-auth on the next hop (credential confusion);
    // fragment is HTTP-irrelevant. Stripping keeps the allowlist matcher
    // host-based (not userinfo-spoofable). Input is post-`new URL()` so
    // the `?? raw` fallback is defensive — never hit in practice.
    const raw = new URL(location, currentUrl).toString();
    const nextUrl = stripUserInfoAndFragment(raw) ?? raw;

    // Per-hop SSRF + allowlist validation. The initial-URL checks only
    // see the operator-supplied target — a redirect chain could pivot to
    // internal targets or off-allowlist hosts without these guards.
    if (isBlockedUrl(nextUrl)) {
      logger.warn("Redirect refused (SSRF blocklist)", {
        integrationId,
        hop,
        host: redactHost(nextUrl),
      });
      throw new RedirectBlockedError("ssrf", nextUrl);
    }
    // The literal `isBlockedUrl` above only sees the redirect target's
    // spelled-out host — a `302 → rebind.attacker.com` whose A record is
    // 169.254.169.254 sails through it. Resolve every A/AAAA record for the
    // hop host and refuse if ANY lands in a blocked range (fail closed on
    // resolution failure), mirroring the initial-target `refuseSsrfUrl` gate.
    const hopHostCheck = await resolveAndCheckHost(new URL(nextUrl).hostname, {
      resolve: opts.resolveHost,
    });
    if (hopHostCheck.blocked) {
      logger.warn("Redirect refused (SSRF DNS-rebind)", {
        integrationId,
        hop,
        host: redactHost(nextUrl),
      });
      throw new RedirectBlockedError("ssrf", nextUrl);
    }
    if (hasAllowlist && !allowAllUris && !matchesAuthorizedUri(nextUrl, authorizedUris!)) {
      logger.warn("Redirect refused (not in authorizedUris)", {
        integrationId,
        hop,
        host: redactHost(nextUrl),
      });
      throw new RedirectBlockedError("unauthorized", nextUrl);
    }

    // Hybrid credential strip:
    //   - Declared allowlist (and not allowAllUris) → every surviving hop
    //     is in-allowlist by construction, credentials are safe to forward
    //     (multi-host APIs like Dropbox work).
    //   - allowAllUris / no allowlist → no declared trust boundary, fall
    //     back to WHATWG origin-based strip.
    const crossOrigin = new URL(nextUrl).origin !== new URL(currentUrl).origin;
    const stripCred = (!hasAllowlist || !!allowAllUris) && crossOrigin;

    const headers = new Headers(currentInit.headers as RequestInit["headers"]);
    headers.delete("cookie");
    // Compose Cookie from caller-supplied + jar (jar wins on dup name).
    const merged = new Map(callerCookies);
    for (const ck of cookieJar.get(integrationId) ?? []) merged.set(ck.split("=")[0]!, ck);
    if (merged.size) headers.set("cookie", [...merged.values()].join("; "));
    if (dropBody) {
      headers.delete("content-length");
      headers.delete("content-type");
    }
    if (stripCred) {
      headers.delete("authorization");
      if (injectedCredentialHeader) headers.delete(injectedCredentialHeader);
      // Cookies are credentials too. The jar/caller cookies were composed
      // above unconditionally (to follow intra-allowlist multi-host flows);
      // strip them on an out-of-boundary cross-origin hop so an
      // upstream-controlled redirect can't exfiltrate the session jar.
      headers.delete("cookie");
    }

    currentInit = {
      ...currentInit,
      method: dropBody ? "GET" : currentInit.method,
      body: dropBody ? undefined : currentInit.body,
      headers,
    };
    currentUrl = nextUrl;
  }

  throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting at ${url}`);
}

/**
 * One-shot guarded fetch for callers that DON'T need cookie-jar continuity
 * across multiple calls (the standalone CLI's `LocalIntegrationResolver`).
 *
 * Runs the initial-URL preflight ({@link preflightUrl}), then dispatches
 * through {@link fetchFollowingRedirectsCapturingCookies} with a fresh
 * per-call jar — gaining the per-hop SSRF + allowlist + credential-strip
 * hardening the sidecar already had. The caller MUST have injected its
 * credential header into `init.headers` already.
 *
 * Throws:
 *   - {@link PreflightError} when the initial target fails the allowlist /
 *     SSRF preflight (no outbound bytes sent).
 *   - {@link RedirectBlockedError} when a redirect hop is refused.
 *   - the underlying fetch error on a network fault.
 *
 * Streaming request bodies (`init.body instanceof ReadableStream`) cannot
 * be replayed across hops, so this helper refuses to follow them — it
 * issues a single `redirect: "manual"` fetch and returns the (possibly
 * 30x) response unfollowed, exactly like the sidecar's streaming path.
 */
export interface GuardedFetchOptions {
  url: string;
  init: RequestInit;
  fetchFn?: typeof fetch;
  authorizedUris?: string[] | null;
  allowAllUris?: boolean;
  /** Lowercased name of the credential header injected by the caller. */
  injectedCredentialHeader?: string | null;
  integrationId?: string;
  logger?: RedirectLogger;
  /** DNS resolver for the SSRF rebind preflight — injectable for tests. */
  resolveHost?: HostResolver;
}

export class PreflightError extends Error {
  constructor(
    public readonly reason: "ssrf" | "not_authorized",
    message: string,
  ) {
    super(message);
    this.name = "PreflightError";
  }
}

export async function guardedFetch(
  opts: GuardedFetchOptions,
): Promise<{ response: Response; finalUrl: string; hops: number }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const pre = await preflightUrl(opts.url, {
    authorizedUris: opts.authorizedUris,
    allowAllUris: opts.allowAllUris,
    resolveHost: opts.resolveHost,
  });
  if (!pre.ok) {
    throw new PreflightError(pre.reason, pre.message);
  }

  const init = opts.init;
  const initAny = init as RequestInit & Record<string, unknown>;
  if (initAny.body instanceof ReadableStream) {
    // Streaming bodies can't be replayed across hops — return the 30x
    // unfollowed (credential stays on the initial, allowlist-checked
    // origin only). Mirrors the sidecar's streaming branch.
    initAny.duplex = "half";
    initAny.redirect = "manual";
    const response = await fetchFn(opts.url, init);
    // Streaming path issues a single unfollowed request — no manual hops.
    return { response, finalUrl: response.url || opts.url, hops: 0 };
  }

  return fetchFollowingRedirectsCapturingCookies({
    url: opts.url,
    init,
    fetchFn,
    cookieJar: new Map<string, string[]>(),
    integrationId: opts.integrationId ?? "local",
    injectedCredentialHeader: opts.injectedCredentialHeader ?? null,
    authorizedUris: opts.authorizedUris ?? undefined,
    allowAllUris: opts.allowAllUris,
    ...(opts.resolveHost ? { resolveHost: opts.resolveHost } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
}
