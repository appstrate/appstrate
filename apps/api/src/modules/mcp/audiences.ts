// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 8707 audience set for the inbound MCP server, org-aware.
 *
 * Each organization exposes its own MCP endpoint (`/api/mcp/o/:org`) whose
 * canonical resource URI a client requests as the RFC 8707 `resource`. The
 * authorization server only mints a token bound to a resource that is in its
 * `validAudiences` allowlist — but orgs are dynamic, so the allowlist cannot be
 * a static boot-time array.
 *
 * This module owns ONE mutable array (`mcpValidAudiences`) that is passed by
 * reference into both the oauth-provider and the OIDC guards plugin. Both read
 * it live on every `/oauth2/token` call (the library's `checkResource` reads
 * `opts.validAudiences` per call; the guard reads it per request), so mutating
 * this array in place — seeding from the `organizations` table at boot and
 * keeping it in sync via the `onOrgCreate` / `onOrgDelete` events — makes a
 * freshly-created org's audience immediately mintable without a restart.
 *
 * The array is mutated IN PLACE (never reassigned) so the reference handed to
 * the plugins stays valid for the process lifetime.
 */

import { getEnv } from "@appstrate/env";

/** The live allowlist passed (by reference) to the AS + guards plugin. */
export const mcpValidAudiences: string[] = [];

let staticBase: readonly string[] = [];
const orgIds = new Set<string>();

/**
 * Cached end-user-token verifier audience list, keyed on the `APP_URL` it was
 * built from. Invalidated on every `rebuild()` (org set changed) AND whenever
 * `APP_URL` changes (the base URIs derive from it — fixed per process in prod,
 * but swapped by tests that re-init `getEnv`), so the cache can never serve a
 * stale base.
 */
let verifyAudiencesCache: { appBase: string; audiences: string[] } | null = null;

/** Canonical per-org MCP resource URI — byte-stable (org id, not slug). */
export function getMcpOrgResourceUri(orgId: string): string {
  return `${getEnv().APP_URL.replace(/\/+$/, "")}/api/mcp/o/${orgId}`;
}

/**
 * Parse an org id out of a per-org MCP resource URI.
 *
 * Returns `<id>` iff `uri` is EXACTLY `${APP_URL}/api/mcp/o/<id>` — same
 * `APP_URL` normalization as `getMcpOrgResourceUri` (trailing slashes stripped),
 * with `<id>` being a single non-empty path segment and NOTHING after it. The
 * trailing-segment guard is deliberate: a token whose audience is a SUB-path
 * (`…/o/<id>/extra`) or a query-decorated variant must NOT be read as a binding
 * to org `<id>`, otherwise audience confinement could be sidestepped by a
 * crafted URI. This is pure URI parsing — it does NOT check that `<id>` names a
 * real org (that membership re-check happens later in org-context).
 */
export function orgIdFromMcpAudience(uri: string): string | undefined {
  const prefix = `${getEnv().APP_URL.replace(/\/+$/, "")}/api/mcp/o/`;
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

function rebuild(): void {
  mcpValidAudiences.length = 0;
  mcpValidAudiences.push(...staticBase, ...[...orgIds].map(getMcpOrgResourceUri));
  // Drop the verifier cache so the next `getEndUserVerifyAudiences()` rebuilds
  // it against the new org set — keeps the verifier in lockstep with the mint
  // allowlist without recomputing on every verify.
  verifyAudiencesCache = null;
}

/**
 * Set the static (non-org) audiences — the platform + AS URIs and the generic
 * MCP resource. Called once from `plugins.ts` at construction. Org audiences
 * are layered on top and survive re-init.
 */
export function initMcpValidAudiences(base: readonly string[]): void {
  staticBase = [...base];
  rebuild();
}

/** Replace the org audience set (boot seed from the organizations table). */
export function seedMcpOrgAudiences(ids: readonly string[]): void {
  orgIds.clear();
  for (const id of ids) orgIds.add(id);
  rebuild();
}

/** Add one org's audience (on org creation). Idempotent. */
export function addMcpOrgAudience(orgId: string): void {
  if (orgIds.has(orgId)) return;
  orgIds.add(orgId);
  rebuild();
}

/** Remove one org's audience (on org deletion). Idempotent. */
export function removeMcpOrgAudience(orgId: string): void {
  if (!orgIds.delete(orgId)) return;
  rebuild();
}

/**
 * Audience allowlist for the end-user token VERIFIER (`enduser-token.ts`): the
 * platform + AS base URIs plus one per-org MCP resource URI each — exactly the
 * set the AS mints against. The base is computed locally from `APP_URL` (NOT
 * read from `mcpValidAudiences`), so verification works in any context,
 * independent of the AS plugin having run `initMcpValidAudiences` at boot (e.g.
 * unit tests that never construct the plugin).
 *
 * Cached and invalidated on every `rebuild()` (org create / delete / seed), so
 * the hot auth path — every `Bearer ey…` verify, MCP-bound or not — pays O(1)
 * array reuse instead of rebuilding O(orgs) strings per request. jose treats the
 * `audience` argument as read-only, so returning the shared array is safe.
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

/** Test-only — drop org audiences between fixtures. */
export function _resetMcpOrgAudiencesForTesting(): void {
  orgIds.clear();
  rebuild();
}
