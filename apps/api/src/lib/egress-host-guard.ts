// SPDX-License-Identifier: Apache-2.0

import {
  resolveAndCheckHost,
  isBlockedUrl,
  guardedFetch,
  type GuardedFetchOptions,
  type ResolvedHostCheck,
} from "@appstrate/core/ssrf";
import { isAllowedInternalIdpHost } from "@appstrate/connect";

/**
 * Allowlist-aware server-egress host check for platform-initiated fetches to an
 * operator-configured URL (LLM upstream, org proxy, org model test, credential
 * proxy target, remote MCP server).
 *
 * Wraps {@link resolveAndCheckHost} (DNS-resolve + private/link-local/loopback
 * blocklist, fail-closed) with the operator internal-host allowlist
 * (`EGRESS_ALLOW_INTERNAL_HOSTS`): a host the operator has explicitly declared
 * trusted — a self-hosted deployment reaching an internal model/proxy/IdP/MCP
 * endpoint on a private address — is exempt. Unset in production by default, so
 * every host stays fully guarded.
 *
 * Lower-level primitive; most callers should use {@link checkEgressUrl}, which
 * layers URL parse + scheme floor on top so the whole egress decision lives in
 * one place.
 */
export async function checkEgressHost(hostname: string): Promise<ResolvedHostCheck> {
  if (isAllowedInternalIdpHost(hostname)) {
    return { blocked: false, pinnedAddress: hostname };
  }
  return resolveAndCheckHost(hostname);
}

/**
 * Allowlist-aware literal (no-DNS) twin of {@link checkEgressHost}. Retained for
 * the config-write path (org proxy create/update) that validates a URL before
 * it is ever fetched — there is nothing to DNS-resolve at rest, only a literal
 * blocklist to enforce. Runtime egress sites use {@link checkEgressUrl}, which
 * subsumes this literal check inside its host gate. Parse/scheme stay fail-
 * closed inside `isBlockedUrl`.
 */
export function isBlockedEgressUrl(url: string): boolean {
  return isBlockedUrl(url, isAllowedInternalIdpHost);
}

/** Why {@link checkEgressUrl} refused a URL. `detail` (host block only) is for logs, never a secret. */
export type EgressUrlBlockReason = "invalid-url" | "blocked-scheme" | "blocked-host";

export type EgressUrlCheck =
  | {
      ok: true;
      hostname: string;
      /**
       * The DNS-validated address the caller MUST connect to. Connecting by
       * name instead re-resolves at connect time and reopens the DNS-rebind
       * TOCTOU the guard just closed. For an operator-trusted host
       * (`EGRESS_ALLOW_INTERNAL_HOSTS`) this is the hostname itself —
       * name-based connect is the trusted-by-design path there. Callers that
       * fetch (rather than own a raw socket) should use
       * {@link egressGuardedFetch}, which pins each hop itself.
       */
      pinnedAddress: string;
    }
  | { ok: false; reason: EgressUrlBlockReason; hostname: string | null; detail?: string };

export interface CheckEgressUrlOptions {
  /**
   * When true, plain `http://` is refused for any host NOT on the operator's
   * internal-host allowlist — only `https://` (or an operator-trusted host on
   * http/https) may egress. The remote-MCP spawn path sets this: an
   * authenticated MCP client must never speak plaintext to an untrusted host.
   *
   * When false/unset both http and https reach any non-blocked host — the
   * LLM-upstream / org-proxy / model-test / credential-proxy policy, where an
   * openai-compatible endpoint may legitimately be plain http.
   */
  requireHttpsForUntrustedHost?: boolean;
}

/**
 * Canonical platform-egress guard for a fetch to an operator/agent-supplied
 * URL. ONE decision site for {parse, scheme floor, allowlist-aware literal +
 * DNS-rebind host gate} so the egress sites (LLM upstream, Claude Code
 * subscription gateway, org proxy test, org model test, credential proxy
 * target, remote-MCP spawn) cannot drift apart.
 *
 * Non-throwing: returns a discriminated result so each caller maps a block to
 * its own shape (invalidRequest / TestResult / ProxyAuthorizationError / skip).
 * `detail` carries the DNS block reason for server-side logs — never a secret,
 * never surfaced to the caller.
 *
 * The literal blocklist is folded into the host gate: `checkEgressHost` runs
 * the literal `isBlockedHost` floor before resolving, so a separate
 * `isBlockedEgressUrl` pre-check would be redundant here.
 */
export async function checkEgressUrl(
  rawUrl: string,
  opts?: CheckEgressUrlOptions,
): Promise<EgressUrlCheck> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid-url", hostname: null };
  }
  const hostname = parsed.hostname;

  // Scheme floor. Non-http(s) (file:, gopher:, …) is always refused. Plain http
  // is refused for an untrusted host only when the caller demands it (remote
  // MCP); operator-trusted hosts keep http (internal LAN services lack TLS).
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "blocked-scheme", hostname };
  }
  if (
    opts?.requireHttpsForUntrustedHost &&
    parsed.protocol === "http:" &&
    !isAllowedInternalIdpHost(hostname)
  ) {
    return { ok: false, reason: "blocked-scheme", hostname };
  }

  // Allowlist-aware literal + DNS-rebind host gate: an operator-trusted host
  // short-circuits to allowed, every other host is DNS-resolved and every
  // A/AAAA record re-checked against the private/loopback/link-local/metadata
  // blocklist (fail-closed).
  const hostCheck = await checkEgressHost(hostname);
  if (hostCheck.blocked) {
    return { ok: false, reason: "blocked-host", hostname, detail: hostCheck.reason };
  }
  return { ok: true, hostname, pinnedAddress: hostCheck.pinnedAddress };
}

/**
 * Canonical platform-egress TRANSPORT for a fetch to an operator/agent-supplied
 * URL: {@link guardedFetch} pre-wired with the operator internal-host allowlist
 * so runtime egress sites (credential proxy, webhook delivery, …) share ONE
 * outbound primitive. Per hop it DNS-resolves + blocklist-checks the host and —
 * under Bun with the global fetch — connects to the validated address while
 * preserving the logical `Host` header and TLS SNI/certificate identity, so
 * the check-then-fetch DNS-rebind TOCTOU is closed rather than merely
 * re-checked. Redirects are always followed manually with the full guard
 * re-run on every hop.
 *
 * Callers still run {@link checkEgressUrl} first when they need the richer
 * pre-flight decision (scheme floor options, non-throwing result shape); this
 * wrapper is the actual wire call.
 */
export function egressGuardedFetch(
  input: string | URL,
  init?: RequestInit,
  opts?: Omit<GuardedFetchOptions, "allowHost">,
): Promise<Response> {
  return guardedFetch(input, init, { ...opts, allowHost: isAllowedInternalIdpHost });
}
