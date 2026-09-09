// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 8707 audience vocabulary for the inbound MCP server, org-aware.
 *
 * Platform-level, not module-level, because BOTH built-ins need it and neither
 * owns it: the OIDC token verifier reads it (`services/enduser-token.ts`,
 * `auth/strategy.ts`) and the MCP module keeps it in sync with the org set.
 *
 * Each organization exposes its own MCP endpoint (`/api/mcp/o/:org`) whose
 * canonical resource URI a client requests as the RFC 8707 `resource`.
 *
 * MINTING IS NOT DECIDED HERE. The authorization server resolves a requested
 * `resource` against the persisted `oauth_resources` table and answers
 * `invalid_target` for an identifier it has no row for; the mcp module writes
 * one row per org (`modules/mcp/index.ts`). That table is shared by every
 * replica, so there is no per-process mint allowlist.
 *
 * This module owns the VERIFIER half: `getEndUserVerifyAudiences()` is the
 * `aud` allowlist jose checks a PRESENTED token against on every `Bearer ey…`.
 * It IS per-process in-memory state (a DB read on the hot auth path is not
 * worth it), so the mcp module seeds it at boot, updates it on `onOrgCreate` /
 * `onOrgDelete`, and re-seeds periodically to converge replicas.
 */

import { getEnv } from "@appstrate/env";

/** Org ids whose per-org MCP resource URI the token VERIFIER accepts. */
const orgIds = new Set<string>();

/**
 * Cached verifier audience list, keyed on the `APP_URL` the base URIs derive
 * from. Dropped when the org set changes, rebuilt when that key moves (fixed
 * per process in prod, swapped by tests that re-init `getEnv`).
 */
let verifyAudiencesCache: { appBase: string; audiences: string[] } | null = null;

/** Canonical per-org MCP resource URI — byte-stable (org id, not slug). */
export function getMcpOrgResourceUri(orgId: string): string {
  return `${getEnv().APP_URL}/api/mcp/o/${orgId}`;
}

/**
 * Parse an org id out of a per-org MCP resource URI. Returns `<id>` iff `uri` is
 * EXACTLY `${getMcpOrgResourceUri(id)}`: a sub-path (`…/o/<id>/extra`) or a
 * decorated variant must not read as a binding to `<id>`, or audience
 * confinement could be sidestepped by a crafted URI. Pure URI parsing — whether
 * `<id>` names a real org is re-checked later, in org-context.
 */
export function orgIdFromMcpAudience(uri: string): string | undefined {
  const prefix = `${getEnv().APP_URL}/api/mcp/o/`;
  if (!uri.startsWith(prefix)) return undefined;
  const rest = uri.slice(prefix.length);
  // One non-empty path segment, free of every URL delimiter (`/` `?` `#` `;`),
  // so only the canonical org URI resolves to an org id. The AS mints from
  // `oauth_resources` rows carrying exactly that string, so this is defence in
  // depth against a crafted `aud`.
  if (rest.length === 0 || /[/?#;]/.test(rest)) return undefined;
  return rest;
}

/**
 * First org id among the audience entries. A token is bound to at most one org's
 * endpoint, so the first match is the binding; non-string and unrecognised
 * entries are skipped, and `undefined` means "not an MCP-bound token".
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
 * platform + AS base URIs plus one per-org MCP resource URI each — the set the
 * AS holds `oauth_resources` rows for. The base is computed locally from
 * `APP_URL`, so verification never depends on the AS plugin having been built.
 *
 * jose reads `audience` as "the token must carry at least one of these", so a
 * token whose `aud` also carries the implicit `${baseURL}/oauth2/userinfo`
 * identifier (stamped whenever `openid` is in scope) still matches on its real
 * resource, while one carrying ONLY that identifier is rejected.
 *
 * The shared array is returned as-is: jose treats it read-only, and the hot auth
 * path pays O(1) reuse instead of rebuilding O(orgs) strings per request.
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
