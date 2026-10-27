// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 8707 audience vocabulary for the inbound MCP server, org- and space-aware.
 *
 * Platform-level, not module-level, because BOTH built-ins need it and neither
 * owns it: the OIDC token verifier reads it (`services/enduser-token.ts`,
 * `auth/strategy.ts`) and the MCP module keeps it in sync with the org set.
 *
 * Each organization exposes its own MCP endpoint (`/api/mcp/o/:org`) and one
 * endpoint per space (`/api/mcp/o/:org/s/:space`). Each is its own resource: a
 * client requests that endpoint's canonical URI as the RFC 8707 `resource`.
 *
 * MINTING IS NOT DECIDED HERE. The authorization server resolves a requested
 * `resource` against the persisted `oauth_resources` table and answers
 * `invalid_target` for an identifier it has no row for. The mcp module writes
 * one row per org, and writes a space's row on demand when the AS is first
 * asked for it (`modules/mcp/oauth-resources.ts`). That table is shared by
 * every replica, so there is no per-process mint allowlist.
 *
 * This module owns the VERIFIER half: `isEndUserVerifyAudience()` is the `aud`
 * predicate checked against a PRESENTED token on every `Bearer ey…`. Its org
 * set IS per-process in-memory state (a DB read on the hot auth path is not
 * worth it), so the mcp module seeds it at boot, updates it on `onOrgCreate` /
 * `onOrgDelete`, and re-seeds periodically to converge replicas. A space URI is
 * accepted when its org is in that set; whether the space belongs to the org is
 * re-checked when the request enters the space.
 */

import { getEnv } from "@appstrate/env";
import { SPACE_ID_RE } from "@appstrate/db/ids";

/** Path prefix of every MCP resource: `<prefix>/<org>` and `<prefix>/<org>/s/<space>`. */
export const MCP_RESOURCE_PREFIX = "/api/mcp/o";

/** What an MCP resource URI binds a token to. */
interface McpResourceBinding {
  orgId: string;
  spaceId?: string;
}

/** Org ids whose MCP resource URIs the token VERIFIER accepts. */
const orgIds = new Set<string>();

/** Canonical per-org MCP resource URI — byte-stable (org id, not slug). */
export function getMcpOrgResourceUri(orgId: string): string {
  return `${getEnv().APP_URL}${MCP_RESOURCE_PREFIX}/${orgId}`;
}

/** Canonical per-space MCP resource URI: the org URI plus `/s/<spaceId>`. */
export function getMcpSpaceResourceUri(orgId: string, spaceId: string): string {
  return `${getMcpOrgResourceUri(orgId)}/s/${spaceId}`;
}

/**
 * Parse the binding of a URI after the MCP prefix (`<org>` or `<org>/s/<space>`).
 * The org segment is non-empty and free of every URL delimiter (`/` `?` `#`
 * `;`); the space segment matches `SPACE_ID_RE`; nothing follows it. So only a
 * canonical URI binds, and a decorated variant (`…/s/<spc>/..`, a query, a
 * sub-path) never does. Whether the ids name real rows is re-checked later.
 */
function parseBinding(rest: string): McpResourceBinding | undefined {
  const parts = rest.split("/");
  const orgId = parts[0] ?? "";
  if (orgId.length === 0 || /[?#;]/.test(orgId)) return undefined;
  if (parts.length === 1) return { orgId };
  if (parts.length !== 3 || parts[1] !== "s") return undefined;
  const spaceId = parts[2]!;
  if (!SPACE_ID_RE.test(spaceId)) return undefined;
  return { orgId, spaceId };
}

/**
 * The binding of an MCP resource URI: exactly `<APP_URL>/api/mcp/o/<org>` or
 * `<APP_URL>/api/mcp/o/<org>/s/<spc>`; anything else is `undefined`.
 */
export function parseMcpResourceUri(uri: string): McpResourceBinding | undefined {
  const prefix = `${getEnv().APP_URL}${MCP_RESOURCE_PREFIX}/`;
  if (!uri.startsWith(prefix)) return undefined;
  return parseBinding(uri.slice(prefix.length));
}

/**
 * First MCP binding among the audience entries. A token is bound to at most one
 * MCP resource, so the first match is the binding; non-string and unrecognised
 * entries are skipped, and `undefined` means "not an MCP-bound token".
 */
export function mcpBindingFromAudiences(
  audiences: readonly unknown[],
): McpResourceBinding | undefined {
  for (const entry of audiences) {
    if (typeof entry !== "string") continue;
    const binding = parseMcpResourceUri(entry);
    if (binding) return binding;
  }
  return undefined;
}

/**
 * The resource a request path addresses: `/api/mcp/o/<org>` is the org URI,
 * `/api/mcp/o/<org>/s/<spc>` the space URI (either with one trailing `/`), and
 * any other path under the prefix addresses no resource.
 */
export function deriveMcpResourceUri(path: string): string | undefined {
  const prefix = `${MCP_RESOURCE_PREFIX}/`;
  if (!path.startsWith(prefix)) return undefined;
  let rest = path.slice(prefix.length);
  if (rest.endsWith("/")) rest = rest.slice(0, -1);
  const binding = parseBinding(rest);
  if (!binding) return undefined;
  return binding.spaceId === undefined
    ? getMcpOrgResourceUri(binding.orgId)
    : getMcpSpaceResourceUri(binding.orgId, binding.spaceId);
}

/**
 * Resources enclosing `uri` whose tokens it also accepts: a space endpoint
 * accepts its organization's token; nothing else encloses anything.
 */
export function enclosingMcpResourceUris(uri: string): string[] {
  const binding = parseMcpResourceUri(uri);
  if (binding?.spaceId === undefined) return [];
  return [getMcpOrgResourceUri(binding.orgId)];
}

/** Replace the verifier's org set (boot seed / periodic re-seed from the DB). */
export function setMcpOrgVerifyAudiences(ids: readonly string[]): void {
  orgIds.clear();
  for (const id of ids) orgIds.add(id);
}

/** Accept one org's audiences at verify time (on org creation). Idempotent. */
export function addMcpOrgVerifyAudience(orgId: string): void {
  orgIds.add(orgId);
}

/** Stop accepting one org's audiences (on org deletion). Idempotent. */
export function removeMcpOrgVerifyAudience(orgId: string): void {
  orgIds.delete(orgId);
}

/**
 * Whether the end-user token VERIFIER (`enduser-token.ts`) accepts `aud`: the
 * platform or AS base URI, or an MCP resource (org or space) of an org in the
 * verifier set. The base URIs are computed locally from `APP_URL`, so
 * verification never depends on the AS plugin having been built.
 *
 * The caller requires at least one accepted entry, so a token whose `aud` also
 * carries the implicit `${baseURL}/oauth2/userinfo` identifier (stamped whenever
 * `openid` is in scope) still matches on its real resource, while one carrying
 * ONLY that identifier is rejected.
 */
export function isEndUserVerifyAudience(aud: string): boolean {
  const appBase = getEnv().APP_URL;
  if (aud === appBase || aud === `${appBase}/api/auth`) return true;
  const binding = parseMcpResourceUri(aud);
  return binding !== undefined && orgIds.has(binding.orgId);
}
