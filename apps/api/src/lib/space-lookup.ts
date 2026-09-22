// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a space row by id. Free of Hono and of the pipeline: the role preview
 * (`lib/view-as.ts`) needs these lookups before any middleware has run, and
 * keeping them in `middleware/space-context.ts` made `lib` and `middleware`
 * import each other.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizationMembers, spaceMembers, spaceRoles, spaces } from "@appstrate/db/schema";
import type { OrgRole } from "@appstrate/core/permissions";
import { assertSpaceId } from "./ids.ts";
import {
  customRoleOn,
  MEMBERSHIP_COLUMNS,
  memberFromJoin,
  membershipOn,
  type SpaceMemberRow,
} from "./space-role.ts";

/** Space row exposed as `c.get("space")`. Keep the field set tight so services can destructure it. */
export interface SpaceContextRow {
  id: string;
  orgId: string;
  isDefault: boolean;
  visibility: import("@appstrate/core/permissions").SpaceVisibility;
  defaultRole: import("@appstrate/core/permissions").SpaceRolePreset;
  /** Set on a personal space; `resolveSpaceRole` reads it before the org role. */
  ownerUserId: string | null;
  /** When the owner left the organization — the sweeper's window (RBAC spec §3.6). */
  orphanedAt: Date | null;
}

/** Projection behind {@link SpaceContextRow} — declared once so its readers cannot drift. */
const SPACE_CONTEXT_COLUMNS = {
  id: spaces.id,
  orgId: spaces.orgId,
  isDefault: spaces.isDefault,
  visibility: spaces.visibility,
  defaultRole: spaces.defaultRole,
  ownerUserId: spaces.ownerUserId,
  orphanedAt: spaces.orphanedAt,
} as const;

/**
 * The space row, or null if it is not in `orgId`. Where a CLIENT-SUPPLIED
 * space id enters (middleware, MCP router — SSE auth enters through
 * {@link loadSpaceAccess}, which carries the same guard), hence the id-shape guard,
 * run BEFORE the SELECT: a retired `app_` id is un-migrated data, not a missing
 * row, and must throw rather than 404 (header, key and row would still agree).
 * Paths reading the id from a row assert the shape themselves: the
 * `requireSpaceContext` / `resolveMcpSpaceRow` default-space fallbacks.
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

/** The org's default space — the fallback for header-less in-process MCP re-entry (see `requireSpaceContext`). */
export async function defaultSpaceForOrg(orgId: string): Promise<SpaceContextRow | null> {
  const [space] = await db
    .select(SPACE_CONTEXT_COLUMNS)
    .from(spaces)
    .where(and(eq(spaces.orgId, orgId), eq(spaces.isDefault, true)))
    .limit(1);
  return space ?? null;
}

/** What `resolveSpaceRole` needs about one principal in one space, read as one snapshot. */
export interface SpaceAccessSnapshot {
  space: SpaceContextRow;
  member: SpaceMemberRow | null;
  /** `null` when `userId` is not a member of the organization. */
  orgRole: OrgRole | null;
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
  assertSpaceId(spaceId);
  const [row] = await db
    .select({
      space: SPACE_CONTEXT_COLUMNS,
      ...MEMBERSHIP_COLUMNS,
      orgRole: organizationMembers.role,
    })
    .from(spaces)
    .leftJoin(spaceMembers, membershipOn(userId))
    .leftJoin(spaceRoles, customRoleOn)
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, spaces.orgId),
        userId === null ? sql`false` : eq(organizationMembers.userId, userId),
      ),
    )
    .where(and(eq(spaces.id, spaceId), eq(spaces.orgId, orgId)))
    .limit(1);
  return row ? { space: row.space, member: memberFromJoin(row), orgRole: row.orgRole } : null;
}
