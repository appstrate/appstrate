// SPDX-License-Identifier: Apache-2.0

/**
 * Which role a principal holds in one space, and what it grants.
 *
 * Free of Hono and of the request pipeline on purpose: the SSE routes run
 * outside the pipeline and must share this implementation, not a second one.
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md §4
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spaceMembers, spaceRoles, spaces } from "@appstrate/db/schema";
import type { OrgRole, SpaceRolePreset, SpaceVisibility } from "@appstrate/core/permissions";
import { knownSpaceLevelPermissions, presetPermissions, type Permission } from "./permissions.ts";

export interface SpaceAccessRow {
  id: string;
  visibility: SpaceVisibility;
  defaultRole: SpaceRolePreset;
}

export interface CustomSpaceRole {
  id: string;
  key: string;
  name: string;
  permissions: readonly string[];
}

/** Two shapes, not one string: the DB stores presets under a CHECK and customs under an FK. */
export type SpaceRoleRef =
  { kind: "preset"; preset: SpaceRolePreset } | { kind: "custom"; role: CustomSpaceRole };

export interface SpaceMemberRow {
  ref: SpaceRoleRef;
}

/**
 * `null` means no access. Callers turn that into 403 for `open`/`closed` and
 * 404 for `private` — a private space does not exist for someone not in it.
 */
export function resolveSpaceRole(
  orgRole: OrgRole,
  space: SpaceAccessRow,
  memberRow: SpaceMemberRow | null,
): SpaceRoleRef | null {
  // By org role, which is why an explicit row for them is refused at write.
  if (orgRole === "owner" || orgRole === "admin") return { kind: "preset", preset: "admin" };
  // Explicit beats implicit: a `viewer` row in a `builder`-default open space
  // yields `viewer`.
  if (memberRow) return memberRow.ref;
  if (orgRole === "member" && space.visibility === "open") {
    return { kind: "preset", preset: space.defaultRole };
  }
  return null;
}

/**
 * A custom bundle is filtered to what the running platform still understands,
 * so a string that became unknown (module unloaded) never reaches `Set.has`.
 */
export function spacePermissions(ref: SpaceRoleRef | null): Set<Permission> {
  if (!ref) return new Set<Permission>();
  if (ref.kind === "preset") return presetPermissions(ref.preset);
  const known = knownSpaceLevelPermissions();
  const granted = new Set<Permission>();
  for (const perm of ref.role.permissions) {
    if (known.has(perm)) granted.add(perm as Permission);
  }
  return granted;
}

/** One indexed lookup on the composite PK, custom role joined in the same query. */
export async function loadSpaceMember(
  spaceId: string,
  userId: string,
): Promise<SpaceMemberRow | null> {
  const [row] = await db
    .select({
      presetRole: spaceMembers.presetRole,
      customRoleId: spaceMembers.customRoleId,
      customKey: spaceRoles.key,
      customName: spaceRoles.name,
      customPermissions: spaceRoles.permissions,
    })
    .from(spaceMembers)
    .leftJoin(spaceRoles, eq(spaceRoles.id, spaceMembers.customRoleId))
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
    .limit(1);

  return row ? { ref: toRef(row) } : null;
}

/** Shape every explicit-membership query shares. */
export interface MembershipColumns {
  presetRole: SpaceRolePreset | null;
  customRoleId: string | null;
  customKey: string | null;
  customName: string | null;
  customPermissions: string[] | null;
}

/** The `num_nonnulls` CHECK and the FK are what the assertions rest on. */
export function toRef(row: MembershipColumns): SpaceRoleRef {
  if (row.presetRole) return { kind: "preset", preset: row.presetRole };
  return {
    kind: "custom",
    role: {
      id: row.customRoleId!,
      key: row.customKey!,
      name: row.customName!,
      permissions: row.customPermissions!,
    },
  };
}

/** One query for a whole listing — `GET /api/spaces` must not look up per space. */
export async function loadSpaceMemberships(
  orgId: string,
  userId: string,
): Promise<Map<string, SpaceMemberRow>> {
  const rows = await db
    .select({
      spaceId: spaceMembers.spaceId,
      presetRole: spaceMembers.presetRole,
      customRoleId: spaceMembers.customRoleId,
      customKey: spaceRoles.key,
      customName: spaceRoles.name,
      customPermissions: spaceRoles.permissions,
    })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .leftJoin(spaceRoles, eq(spaceRoles.id, spaceMembers.customRoleId))
    .where(and(eq(spaces.orgId, orgId), eq(spaceMembers.userId, userId)));

  const out = new Map<string, SpaceMemberRow>();
  for (const row of rows) out.set(row.spaceId, { ref: toRef(row) });
  return out;
}

export function toSpaceRoleWire(
  ref: SpaceRoleRef | null,
): { kind: "preset" | "custom"; key: string; name: string } | null {
  if (!ref) return null;
  if (ref.kind === "preset") return { kind: "preset", key: ref.preset, name: ref.preset };
  return { kind: "custom", key: ref.role.key, name: ref.role.name };
}
