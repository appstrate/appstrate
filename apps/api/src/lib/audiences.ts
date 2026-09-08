// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 8707 audience vocabulary for the inbound MCP server, org-aware.
 *
 * Platform-level, not module-level, because BOTH built-ins need it and neither
 * owns it: the OIDC token verifier reads it (`services/enduser-token.ts`,
 * `auth/strategy.ts`) and the MCP module keeps it in sync with the org set. It
 * lived under `modules/mcp/` and was reached into from three `oidc` files — the
 * cross-module import the isolation gate exists to refuse, recorded as accepted
 * rather than fixed because "audience parsing is platform vocabulary that landed
 * in the mcp module". This is that fix.
 *
 * Each organization exposes its own MCP endpoint (`/api/mcp/o/:org`) whose
 * canonical resource URI a client requests as the RFC 8707 `resource`.
 *
 * MINTING IS NOT DECIDED HERE. The authorization server resolves a requested
 * `resource` against the persisted `oauth_resources` table and answers
 * `invalid_target` for an identifier it has no row for
 * (`@better-auth/oauth-provider` ≥ 1.7.3). The mcp module writes one row per org
 * (`modules/mcp/index.ts`); that table is shared by every replica, so there is
 * no per-process mint allowlist to keep in sync any more.
 *
 * What remains here is the VERIFIER half: `getEndUserVerifyAudiences()` is the
 * `aud` allowlist jose checks a PRESENTED token against on every `Bearer ey…`.
 * That one IS per-process in-memory state (a DB read on the hot auth path is
 * not worth it), so the mcp module still seeds it at boot, updates it on
 * `onOrgCreate` / `onOrgDelete`, and re-seeds periodically to converge replicas.
 */

import { getEnv } from "@appstrate/env";

/** Org ids whose per-org MCP resource URI the token VERIFIER accepts. */
const orgIds = new Set<string>();

/**
 * Cached end-user-token verifier audience list, keyed on the `APP_URL` it was
 * built from. Invalidated whenever the org set changes AND whenever `APP_URL`
 * changes (the base URIs derive from it — fixed per process in prod, but
 * swapped by tests that re-init `getEnv`), so the cache can never serve a stale
 * base.
 */
let verifyAudiencesCache: { appBase: string; audiences: string[] } | null = null;

/** Canonical per-org MCP resource URI — byte-stable (org id, not slug). */
export function getMcpOrgResourceUri(orgId: string): string {
  return `${getEnv().APP_URL}/api/mcp/o/${orgId}`;
}

/**
 * Parse an org id out of a per-org MCP resource URI.
 *
 * Returns `<id>` iff `uri` is EXACTLY `${APP_URL}/api/mcp/o/<id>` — same
 * canonical `APP_URL` as `getMcpOrgResourceUri`,
 * with `<id>` being a single non-empty path segment and NOTHING after it. The
 * trailing-segment guard is deliberate: a token whose audience is a SUB-path
 * (`…/o/<id>/extra`) or a query-decorated variant must NOT be read as a binding
 * to org `<id>`, otherwise audience confinement could be sidestepped by a
 * crafted URI. This is pure URI parsing — it does NOT check that `<id>` names a
 * real org (that membership re-check happens later in org-context).
 */
export function orgIdFromMcpAudience(uri: string): string | undefined {
  const prefix = `${getEnv().APP_URL}/api/mcp/o/`;
  if (!uri.startsWith(prefix)) return undefined;
  const rest = uri.slice(prefix.length);
  // Exactly one path segment and nothing else: non-empty and free of any URL
  // delimiter (`/` nested, `?` query, `#` fragment, `;` matrix). Reject empty
  // (`…/o/`), nested (`…/o/<id>/…`) and decorated (`…/o/<id>?x`) so ONLY the
  // canonical org URI resolves to an org id — keeps the parser aligned with the
  // mint-time exact-match gate (a token's `aud` can only be a canonical
  // `getMcpOrgResourceUri(orgId)`), defence-in-depth against a crafted aud.
  if (rest.length === 0 || /[/?#;]/.test(rest)) return undefined;
  return rest;
}

/**
 * First org id from any audience entry recognised as a per-org MCP resource
 * URI. A token is audience-bound to at most one org's endpoint, so the first
 * match is the binding; non-string / unrecognised entries are skipped. Returns
 * `undefined` when no audience names a per-org MCP resource (header-path /
 * non-MCP instance tokens).
 */
export function extractOrgIdFromAudiences(audiences: readonly unknown[]): string | undefined {
  for (const entry of audiences) {
    if (typeof entry !== "string") continue;
    const orgId = orgIdFromMcpAudience(entry);
    if (orgId !== undefined) return orgId;
  }
  return undefined;
}

/** Replace the verifier's org set (boot seed / periodic re-seed from the DB). */
export function setMcpOrgVerifyAudiences(ids: readonly string[]): void {
  orgIds.clear();
  for (const id of ids) orgIds.add(id);
  verifyAudiencesCache = null;
}

/** Accept one org's audience at verify time (on org creation). Idempotent. */
export function addMcpOrgVerifyAudience(orgId: string): void {
  if (orgIds.has(orgId)) return;
  orgIds.add(orgId);
  verifyAudiencesCache = null;
}

/** Stop accepting one org's audience (on org deletion). Idempotent. */
export function removeMcpOrgVerifyAudience(orgId: string): void {
  if (!orgIds.delete(orgId)) return;
  verifyAudiencesCache = null;
}

/**
 * Audience allowlist for the end-user token VERIFIER (`enduser-token.ts`): the
 * platform + AS base URIs plus one per-org MCP resource URI each — the same set
 * the AS has `oauth_resources` rows for. The base is computed locally from
 * `APP_URL`, so verification works in any context, independent of the AS plugin
 * having been constructed (e.g. unit tests that never build it).
 *
 * jose treats `audience` as "the token must carry at least one of these", so a
 * token whose `aud` also carries the implicit `${baseURL}/oauth2/userinfo`
 * identifier (stamped by the AS whenever `openid` is in scope) still matches on
 * its real resource — and a token carrying ONLY that identifier is rejected,
 * which is the fail-closed direction.
 *
 * Cached and invalidated whenever the org set changes, so the hot auth path —
 * every `Bearer ey…` verify, MCP-bound or not — pays O(1) array reuse instead of
 * rebuilding O(orgs) strings per request. jose treats the `audience` argument as
 * read-only, so returning the shared array is safe.
 */
export function getEndUserVerifyAudiences(): string[] {
  const appBase = getEnv().APP_URL;
  if (verifyAudiencesCache === null || verifyAudiencesCache.appBase !== appBase) {
    verifyAudiencesCache = {
      appBase,
      audiences: [appBase, `${appBase}/api/auth`, ...[...orgIds].map(getMcpOrgResourceUri)],
    };
  }
  return verifyAudiencesCache.audiences;
}
