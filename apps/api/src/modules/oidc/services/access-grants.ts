// SPDX-License-Identifier: Apache-2.0

/**
 * Access grants — what a person has let act for them outside the browser, in
 * one list: CLI sessions (`cli_refresh_tokens` families, `services/cli-tokens.ts`)
 * and MCP client grants (`services/mcp-grants.ts`). The two keep their own
 * storage and revocation mechanics; this module gives them one shape and one
 * id space, so the personal page and the org-admin page each read and revoke
 * them through a single door.
 *
 * Ids carry their kind: `crf_…` is a CLI family, `mcg_…` an MCP grant.
 */

import { db } from "@appstrate/db/client";
import {
  organizationMembers,
  organizations,
  spaces,
  user as userTable,
} from "@appstrate/db/schema";
import { and, inArray, ne } from "drizzle-orm";
import {
  listSessionsForOrg,
  listSessionsForUser,
  revokeAllFamiliesForUser,
  revokeFamilyForOrgAdmin,
  revokeFamilyForUser,
} from "./cli-tokens.ts";
import {
  isMcpGrantId,
  listMcpGrantsForOrg,
  listMcpGrantsForUser,
  revokeMcpGrant,
  type ClientRegistration,
  type McpGrant,
} from "./mcp-grants.ts";

/** Wire shape of one grant (snake_case, with the carve-out 4b names camelCase). */
export interface AccessGrantDto {
  id: string;
  kind: "cli" | "mcp";
  /** The client's own name. A CLI session has none: it is the platform's CLI. */
  client_name: string | null;
  /** The client's verifiable origin (host), when the platform has one. */
  client_origin: string | null;
  /** How the client is known — `null` for the platform's own CLI. */
  client_registration: ClientRegistration | null;
  /** The device name a CLI session was opened with. */
  device_name: string | null;
  user_agent: string | null;
  created_ip: string | null;
  last_used_ip: string | null;
  /** What the grant reaches: an org or one of its spaces. `null` = every org of the user (CLI). */
  target: {
    orgId: string;
    org_name: string | null;
    spaceId: string | null;
    space_name: string | null;
  } | null;
  /** Live authorizations held under this grant (devices sharing one MCP client). */
  session_count: number;
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
}

/** Org-admin view: who holds it, and whether this admin may end it. */
export interface OrgAccessGrantDto extends AccessGrantDto {
  user: { id: string; name: string | null; email: string | null };
  /**
   * `false` for a CLI session of a member who also belongs to another org: the
   * session serves every org of its owner, so an admin of one cannot end it.
   */
  revocable: boolean;
}

// ─── Personal ────────────────────────────────────────────────────────────────

export async function listAccessGrantsForUser(userId: string): Promise<AccessGrantDto[]> {
  const [cli, mcp] = await Promise.all([listSessionsForUser(userId), listMcpGrantsForUser(userId)]);
  const names = await targetNames(mcp);
  return sortByActivity([...cli.map((s) => cliDto(s)), ...mcp.map((g) => mcpDto(g, names))]);
}

/**
 * Revoke one of the caller's own grants. `false` when the id names no live
 * grant of theirs — unknown, someone else's, or already ended look the same.
 */
export async function revokeAccessGrantForUser(params: {
  userId: string;
  grantId: string;
}): Promise<
  | { revoked: false }
  | { revoked: true; kind: "cli" }
  | { revoked: true; kind: "mcp"; grant: McpGrant }
> {
  const { userId, grantId } = params;
  if (isMcpGrantId(grantId)) {
    const grant = (await listMcpGrantsForUser(userId)).find((g) => g.id === grantId);
    if (!grant) return { revoked: false };
    await revokeMcpGrant(grant);
    return { revoked: true, kind: "mcp", grant };
  }
  const revoked = await revokeFamilyForUser({ userId, familyId: grantId });
  return revoked ? { revoked: true, kind: "cli" } : { revoked: false };
}

/** Revoke every grant of the caller, CLI and MCP. Returns what was ended. */
export async function revokeAllAccessGrantsForUser(
  userId: string,
): Promise<{ revokedCount: number; mcpGrants: McpGrant[] }> {
  const { revokedCount: cliCount } = await revokeAllFamiliesForUser(userId, "user_revoked_all");
  const mcpGrants = await listMcpGrantsForUser(userId);
  for (const grant of mcpGrants) await revokeMcpGrant(grant);
  return { revokedCount: cliCount + mcpGrants.length, mcpGrants };
}

// ─── Org admin ───────────────────────────────────────────────────────────────

/**
 * Every grant reaching `orgId`: the CLI sessions of its current members, and
 * the MCP grants bound to its org or space endpoints.
 */
export async function listAccessGrantsForOrg(orgId: string): Promise<OrgAccessGrantDto[]> {
  const [cli, mcp] = await Promise.all([listSessionsForOrg(orgId), listMcpGrantsForOrg(orgId)]);
  const names = await targetNames(mcp);
  const multiOrg = await membersOfOtherOrgs(
    orgId,
    cli.map((s) => s.userId),
  );
  const mcpUsers = await usersById(mcp.map((g) => g.userId));
  return sortByActivity([
    ...cli.map((s) => ({
      ...cliDto(s),
      user: { id: s.userId, name: s.userName, email: s.userEmail },
      revocable: !multiOrg.has(s.userId),
    })),
    ...mcp.map((g) => {
      const owner = mcpUsers.get(g.userId);
      return {
        ...mcpDto(g, names),
        user: { id: g.userId, name: owner?.name ?? null, email: owner?.email ?? null },
        revocable: true,
      };
    }),
  ]);
}

/**
 * Revoke a grant reaching `orgId` on behalf of an org admin. `false` when the
 * id names no grant this admin can see, or a CLI session they may not end.
 */
export async function revokeAccessGrantForOrgAdmin(params: {
  orgId: string;
  grantId: string;
}): Promise<
  | { revoked: false }
  | { revoked: true; kind: "cli" }
  | { revoked: true; kind: "mcp"; grant: McpGrant }
> {
  const { orgId, grantId } = params;
  if (isMcpGrantId(grantId)) {
    const grant = (await listMcpGrantsForOrg(orgId)).find((g) => g.id === grantId);
    if (!grant) return { revoked: false };
    await revokeMcpGrant(grant);
    return { revoked: true, kind: "mcp", grant };
  }
  const revoked = await revokeFamilyForOrgAdmin({ orgId, familyId: grantId });
  return revoked ? { revoked: true, kind: "cli" } : { revoked: false };
}

// ─── Shaping ─────────────────────────────────────────────────────────────────

function cliDto(s: Awaited<ReturnType<typeof listSessionsForUser>>[number]): AccessGrantDto {
  return {
    id: s.familyId,
    kind: "cli",
    client_name: null,
    client_origin: null,
    client_registration: null,
    device_name: s.deviceName,
    user_agent: s.userAgent,
    created_ip: s.createdIp,
    last_used_ip: s.lastUsedIp,
    target: null,
    session_count: 1,
    lastUsedAt: s.lastUsedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
  };
}

interface TargetNames {
  orgs: Map<string, string>;
  spaces: Map<string, string>;
}

function mcpDto(g: McpGrant, names: TargetNames): AccessGrantDto {
  return {
    id: g.id,
    kind: "mcp",
    client_name: g.clientName,
    client_origin: g.clientOrigin,
    client_registration: g.clientRegistration,
    device_name: null,
    user_agent: g.lastUsedUserAgent,
    created_ip: null,
    last_used_ip: g.lastUsedIp,
    target: {
      orgId: g.orgId,
      org_name: names.orgs.get(g.orgId) ?? null,
      spaceId: g.spaceId,
      space_name: g.spaceId ? (names.spaces.get(g.spaceId) ?? null) : null,
    },
    session_count: g.sessionCount,
    lastUsedAt: g.lastUsedAt?.toISOString() ?? null,
    createdAt: g.createdAt.toISOString(),
    expiresAt: g.expiresAt?.toISOString() ?? null,
  };
}

async function targetNames(grants: McpGrant[]): Promise<TargetNames> {
  const orgIds = [...new Set(grants.map((g) => g.orgId))];
  const spaceIds = [...new Set(grants.flatMap((g) => (g.spaceId ? [g.spaceId] : [])))];
  const [orgRows, spaceRows] = await Promise.all([
    orgIds.length
      ? db
          .select({ id: organizations.id, name: organizations.name })
          .from(organizations)
          .where(inArray(organizations.id, orgIds))
      : [],
    spaceIds.length
      ? db
          .select({ id: spaces.id, name: spaces.name })
          .from(spaces)
          .where(inArray(spaces.id, spaceIds))
      : [],
  ]);
  return {
    orgs: new Map(orgRows.map((o) => [o.id, o.name])),
    spaces: new Map(spaceRows.map((s) => [s.id, s.name])),
  };
}

async function usersById(ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map<string, { name: string | null; email: string | null }>();
  const rows = await db
    .select({ id: userTable.id, name: userTable.name, email: userTable.email })
    .from(userTable)
    .where(inArray(userTable.id, unique));
  return new Map(rows.map((u) => [u.id, { name: u.name, email: u.email }]));
}

/** Members of `orgId` among `userIds` who also belong to another org. */
async function membersOfOtherOrgs(orgId: string, userIds: string[]): Promise<Set<string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Set();
  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(inArray(organizationMembers.userId, unique), ne(organizationMembers.orgId, orgId)));
  return new Set(rows.map((r) => r.userId));
}

function sortByActivity<T extends AccessGrantDto>(grants: T[]): T[] {
  const ts = (g: AccessGrantDto) => Date.parse(g.lastUsedAt ?? g.createdAt);
  return grants.sort((a, b) => ts(b) - ts(a));
}
