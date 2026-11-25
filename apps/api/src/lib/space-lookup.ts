// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a space row by id. Free of Hono and of the pipeline: the role preview
 * (`lib/view-as.ts`) needs these lookups before any middleware has run, and
 * keeping them in `middleware/space-context.ts` made `lib` and `middleware`
 * import each other.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  organizationMembers,
  organizations,
  spaceMembers,
  spaceRoles,
  spaces,
} from "@appstrate/db/schema";
import type { OrgRole } from "@appstrate/core/permissions";
import { assertSpaceId } from "./ids.ts";
import {
  customRoleOn,
  MEMBERSHIP_COLUMNS,
  memberFromJoin,
  membershipOn,
  PERSONAL_SPACE_DEFAULT_COLUMNS,
  personalSpaceDefaultRef,
  type SpaceMemberRow,
  type SpaceRoleRef,
} from "./space-role.ts";

/** Space row exposed as `c.get("space")`. Keep the field set tight so services can destructure it. */
export interface SpaceContextRow {
  id: string;
  orgId: string;
  name: string;
  isDefault: boolean;
  visibility: import("@appstrate/core/permissions").SpaceVisibility;
  defaultRole: import("@appstrate/core/permissions").SpaceRolePreset;
  /** Set on a personal space; `resolveSpaceRole` reads it before the org role. */
  ownerUserId: string | null;
  /** When the owner left the organization — the sweeper's window (RBAC spec §3.6). */
  orphanedAt: Date | null;
  /** Whether the credential proxy serves calls made outside a run here (`reachOutsideRun`). */
  credentialProxyOpen: boolean;
}

/** Projection behind {@link SpaceContextRow} — declared once so its readers cannot drift. */
export const SPACE_CONTEXT_COLUMNS = {
  id: spaces.id,
  orgId: spaces.orgId,
  name: spaces.name,
  isDefault: spaces.isDefault,
  visibility: spaces.visibility,
  defaultRole: spaces.defaultRole,
  ownerUserId: spaces.ownerUserId,
  orphanedAt: spaces.orphanedAt,
  credentialProxyOpen: spaces.credentialProxyOpen,
} as const;

/**
 * Returns the space in this organization, or null when it is absent. Validate the ID
 * before querying so malformed input receives a 400 and a missing space receives a 404.
 */
export async function validateSpaceInOrg(
  spaceId: string,
  orgId: string,
): Promise<SpaceContextRow | null> {
  assertSpaceId(spaceId);
  const [space] = await db
    .select(SPACE_CONTEXT_COLUMNS)
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.orgId, orgId)))
    .limit(1);
  return space ?? null;
}

/** What `resolveSpaceRole` needs about one principal in one space, read as one snapshot. */
export interface SpaceAccessSnapshot {
  space: SpaceContextRow;
  member: SpaceMemberRow | null;
  /** `null` when `userId` is not a member of the organization. */
  orgRole: OrgRole | null;
  /** The org's `personal_space_role`, resolved from the same statement (RBAC spec §4.4). */
  personalSpaceDefault: SpaceRoleRef;
}

/**
 * The space, `userId`'s explicit row and org role in ONE statement (RBAC spec
 * §4.4); `null` outside `orgId`. `userId: null` reads the space alone (a role
 * preview). Shape-guards the id like {@link validateSpaceInOrg}.
 */
export async function loadSpaceAccess(
  spaceId: string,
  orgId: string,
  userId: string | null,
): Promise<SpaceAccessSnapshot | null> {
  const [row] = await loadSpaceAccessForIds([spaceId], orgId, userId);
  return row ?? null;
}

/** The same role snapshot for several spaces, in one statement. */
export async function loadSpaceAccessForIds(
  spaceIds: readonly string[],
  orgId: string,
  userId: string | null,
): Promise<SpaceAccessSnapshot[]> {
  if (spaceIds.length === 0) return [];
  for (const id of spaceIds) assertSpaceId(id);
  const rows = await db
    .select({
      space: SPACE_CONTEXT_COLUMNS,
      ...MEMBERSHIP_COLUMNS,
      orgRole: organizationMembers.role,
      ...PERSONAL_SPACE_DEFAULT_COLUMNS,
    })
    .from(spaces)
    .innerJoin(organizations, eq(organizations.id, spaces.orgId))
    .leftJoin(spaceMembers, membershipOn(userId))
    .leftJoin(spaceRoles, customRoleOn)
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, spaces.orgId),
        userId === null ? sql`false` : eq(organizationMembers.userId, userId),
      ),
    )
    .where(and(inArray(spaces.id, [...spaceIds]), eq(spaces.orgId, orgId)));
  return rows.map((row) => ({
    space: row.space,
    member: memberFromJoin(row),
    orgRole: row.orgRole,
    personalSpaceDefault: personalSpaceDefaultRef(row),
  }));
}
