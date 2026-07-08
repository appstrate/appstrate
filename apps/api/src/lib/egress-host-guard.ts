// SPDX-License-Identifier: Apache-2.0

import { resolveAndCheckHost, isBlockedUrl, type ResolvedHostCheck } from "@appstrate/core/ssrf";
import { isAllowedInternalIdpHost } from "@appstrate/connect";

/**
 * Allowlist-aware server-egress host check for platform-initiated fetches to an
 * operator-configured URL (LLM upstream, org proxy, org model test, credential
 * proxy target, remote MCP server).
 *
 * Wraps {@link resolveAndCheckHost} (DNS-resolve + private/link-local/loopback
 * blocklist, fail-closed) with the operator internal-host allowlist
 * (`OAUTH_ALLOWED_INTERNAL_IDP_HOSTS`): a host the operator has explicitly
 * declared trusted — a self-hosted deployment reaching an internal model/proxy/
 * IdP/MCP endpoint on a private address — is exempt. Unset in production by
 * default, so every host stays fully guarded. Callers keep their own
 * blocked-verdict handling; this only centralizes the allowlist-then-resolve
 * decision so it can't drift between egress sites.
 */
export async function checkEgressHost(hostname: string): Promise<ResolvedHostCheck> {
  if (isAllowedInternalIdpHost(hostname)) {
    return { blocked: false, pinnedAddress: hostname };
  }
  return resolveAndCheckHost(hostname);
}

/**
 * Allowlist-aware literal (no-DNS) twin of {@link checkEgressHost} for the
 * same egress sites. Without it, a LITERAL private/CGN address (e.g. a
 * Tailscale `100.x` model endpoint or org proxy) can never be exempted: the
 * bare `isBlockedUrl` check fires before the allowlist-aware DNS gate is
 * ever consulted. Parse/scheme stay fail-closed inside `isBlockedUrl`.
 */
export function isBlockedEgressUrl(url: string): boolean {
  return isBlockedUrl(url, isAllowedInternalIdpHost);
}
