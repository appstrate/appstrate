// SPDX-License-Identifier: Apache-2.0

/**
 * Access grants — what a person has let act for them outside the browser:
 * CLI sessions (`crf_…`, `services/cli-tokens.ts`) and MCP client grants
 * (`mcg_…`, `services/mcp-grants.ts`). Each kind keeps its own storage and
 * revocation; this module gives them one wire shape and one id space.
 */

import { db } from "@appstrate/db/client";
import { organizationMembers, user as userTable } from "@appstrate/db/schema";
import { eq, inArray } from "drizzle-orm";
import {
  listSessionsForOrg,
  listSessionsForUser,
  membersOfOtherOrgs,
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
  /** The MCP client's declared name; `null` for a CLI session. */
  client_name: string | null;
  client_origin: string | null;
  client_registration: ClientRegistration | null;
  /** The device name a CLI session was opened with. */
  device_name: string | null;
  user_agent: string | null;
  last_used_ip: string | null;
  /** What an MCP grant reaches; `null` for a CLI session, which acts in every org of its owner. */
  target: {
    orgId: string;
    org_name: string;
    spaceId: string | null;
    space_name: string | null;
  } | null;
  /** Live authorizations held under the grant. */
  session_count: number;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Org-admin view: who holds it, and whether this admin may end it. */
export interface OrgAccessGrantDto extends AccessGrantDto {
  user: { id: string; name: string | null; email: string | null };
  revocable: boolean;
}

type RevokeOutcome =
  | { revoked: false }
  | { revoked: true; kind: "cli" }
  | { revoked: true; kind: "mcp"; grant: McpGrant };

// ─── Personal ────────────────────────────────────────────────────────────────

export async function listAccessGrantsForUser(userId: string): Promise<AccessGrantDto[]> {
  const [cli, mcp] = await Promise.all([listSessionsForUser(userId), listMcpGrantsForUser(userId)]);
  return sortByActivity([...cli.map(cliDto), ...mcp.map(mcpDto)]);
}

/** `revoked: false` when the id names no live grant of the caller's. */
export async function revokeAccessGrantForUser(params: {
  userId: string;
  grantId: string;
}): Promise<RevokeOutcome> {
  const { userId, grantId } = params;
  if (isMcpGrantId(grantId)) {
    return revokeListed(await listMcpGrantsForUser(userId), grantId);
  }
  const revoked = await revokeFamilyForUser({ userId, familyId: grantId });
  return revoked ? { revoked: true, kind: "cli" } : { revoked: false };
}

export async function revokeAllAccessGrantsForUser(
  userId: string,
): Promise<{ revokedCount: number; mcpGrants: McpGrant[] }> {
  const { revokedCount } = await revokeAllFamiliesForUser(userId, "user_revoked_all");
  const mcpGrants = await listMcpGrantsForUser(userId);
  for (const grant of mcpGrants) await revokeMcpGrant(grant);
  return { revokedCount: revokedCount + mcpGrants.length, mcpGrants };
}

// ─── Org admin ───────────────────────────────────────────────────────────────

/**
 * The grants reaching `orgId` held by its current members: their CLI sessions,
 * and their MCP grants on the org's endpoint or on a space the admin can see
 * (`visibleSpaceIds` — another member's personal space does not exist for them).
 */
export async function listAccessGrantsForOrg(
  orgId: string,
  visibleSpaceIds: Set<string>,
): Promise<OrgAccessGrantDto[]> {
  const memberIds = await orgMemberIds(orgId);
  const [cli, mcp, multiOrg] = await Promise.all([
    listSessionsForOrg(orgId),
    listMcpGrantsForOrg({ orgId, userIds: memberIds, spaceIds: visibleSpaceIds }),
    membersOfOtherOrgs(orgId, memberIds),
  ]);
  const holders = await usersById(mcp.map((g) => g.userId));
  return sortByActivity([
    ...cli.map((s) => ({
      ...cliDto(s),
      user: { id: s.userId, name: s.userName, email: s.userEmail },
      revocable: !multiOrg.has(s.userId),
    })),
    ...mcp.map((g) => ({
      ...mcpDto(g),
      user: { id: g.userId, ...(holders.get(g.userId) ?? { name: null, email: null }) },
      revocable: true,
    })),
  ]);
}

/** `revoked: false` when the id names no grant this admin can see, or one they may not end. */
export async function revokeAccessGrantForOrgAdmin(params: {
  orgId: string;
  visibleSpaceIds: Set<string>;
  grantId: string;
}): Promise<RevokeOutcome> {
  const { orgId, visibleSpaceIds, grantId } = params;
  if (isMcpGrantId(grantId)) {
    const userIds = await orgMemberIds(orgId);
    const grants = await listMcpGrantsForOrg({ orgId, userIds, spaceIds: visibleSpaceIds });
    return revokeListed(grants, grantId);
  }
  const revoked = await revokeFamilyForOrgAdmin({ orgId, familyId: grantId });
  return revoked ? { revoked: true, kind: "cli" } : { revoked: false };
}

// ─── Shaping ─────────────────────────────────────────────────────────────────

async function revokeListed(grants: McpGrant[], grantId: string): Promise<RevokeOutcome> {
  const grant = grants.find((g) => g.id === grantId);
  if (!grant) return { revoked: false };
  await revokeMcpGrant(grant);
  return { revoked: true, kind: "mcp", grant };
}

function cliDto(s: Awaited<ReturnType<typeof listSessionsForUser>>[number]): AccessGrantDto {
  return {
    id: s.familyId,
    kind: "cli",
    client_name: null,
    client_origin: null,
    client_registration: null,
    device_name: s.deviceName,
    user_agent: s.userAgent,
    last_used_ip: s.lastUsedIp ?? s.createdIp,
    target: null,
    session_count: 1,
    lastUsedAt: s.lastUsedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

function mcpDto(g: McpGrant): AccessGrantDto {
  return {
    id: g.id,
    kind: "mcp",
    client_name: g.clientName,
    client_origin: g.clientOrigin,
    client_registration: g.clientRegistration,
    device_name: null,
    user_agent: null,
    last_used_ip: g.lastUsedIp,
    target: { orgId: g.orgId, org_name: g.orgName, spaceId: g.spaceId, space_name: g.spaceName },
    session_count: g.sessionCount,
    lastUsedAt: g.lastUsedAt?.toISOString() ?? null,
    createdAt: g.createdAt.toISOString(),
  };
}

async function orgMemberIds(orgId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, orgId));
  return rows.map((r) => r.userId);
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

/** Most recent activity first; a grant never used ranks by when it was opened. */
function sortByActivity<T extends AccessGrantDto>(grants: T[]): T[] {
  const ts = (g: AccessGrantDto) => Date.parse(g.lastUsedAt ?? g.createdAt);
  return grants.sort((a, b) => ts(b) - ts(a));
}
