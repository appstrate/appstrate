// SPDX-License-Identifier: Apache-2.0

/**
 * Space-role resolution — which role a principal holds in one space, and what
 * that role grants (RBAC spec §4.1).
 *
 * A space is the unit of access: "who can see this agent" is answered by "who
 * is a member of its space". This module owns the two functions that answer
 * it, deliberately free of Hono and of the request pipeline so the SSE routes
 * (which run outside the pipeline) and the middleware share one implementation.
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md §4
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spaceMembers, spaceRoles, spaces } from "@appstrate/db/schema";
import type { OrgRole, SpaceRolePreset, SpaceVisibility } from "@appstrate/core/permissions";
import { knownSpaceLevelPermissions, presetPermissions, type Permission } from "./permissions.ts";

/** Fields of a `spaces` row the resolver reads. */
export interface SpaceAccessRow {
  id: string;
  visibility: SpaceVisibility;
  defaultRole: SpaceRolePreset;
}

/** A custom bundle, as stored. */
export interface CustomSpaceRole {
  id: string;
  key: string;
  name: string;
  permissions: readonly string[];
}

/**
 * The role a principal holds in a space: one of the four shipped presets, or
 * one of the org's own bundles. Two shapes rather than one string because the
 * DB stores them in two columns for the same reason — presets are enforced by
 * CHECK, customs by FK.
 */
export type SpaceRoleRef =
  { kind: "preset"; preset: SpaceRolePreset } | { kind: "custom"; role: CustomSpaceRole };

/** An explicit `space_members` row, already joined to its custom role if any. */
export interface SpaceMemberRow {
  ref: SpaceRoleRef;
}

/**
 * The role `orgRole` holds in `space`, given its explicit membership row (or
 * its absence).
 *
 * `null` means no access: the caller is a guest, or the space is `closed` /
 * `private` and no row grants entry. Callers turn that into 403 for
 * `open`/`closed` and 404 for `private` — a private space does not exist for
 * someone who is not in it.
 */
export function resolveSpaceRole(
  orgRole: OrgRole,
  space: SpaceAccessRow,
  memberRow: SpaceMemberRow | null,
): SpaceRoleRef | null {
  // Owners and admins run every space by virtue of the org role; that is why
  // an explicit row for them is refused at write.
  if (orgRole === "owner" || orgRole === "admin") return { kind: "preset", preset: "admin" };
  // Explicit beats implicit: a `viewer` row in an open space whose default is
  // `builder` yields `viewer`, not `builder`.
  if (memberRow) return memberRow.ref;
  if (orgRole === "member" && space.visibility === "open") {
    return { kind: "preset", preset: space.defaultRole };
  }
  return null;
}

/**
 * Space-level permissions a role reference grants. A preset resolves through
 * the constant table (plus module preset grants); a custom bundle is its
 * stored array filtered to the strings the running platform still understands,
 * so a permission that became unknown (module unloaded) never reaches
 * `Set.has`.
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

/**
 * Load the explicit membership of `userId` in `spaceId`, resolving a custom
 * role reference to its row in the same query. One indexed lookup on the
 * composite primary key.
 */
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

/** Shape the two membership queries above share. */
interface MembershipColumns {
  presetRole: SpaceRolePreset | null;
  customRoleId: string | null;
  customKey: string | null;
  customName: string | null;
  customPermissions: string[] | null;
}

/**
 * The `num_nonnulls` CHECK guarantees exactly one of the two columns is set,
 * and the FK guarantees the join found the custom row — hence the assertions.
 */
function toRef(row: MembershipColumns): SpaceRoleRef {
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

/**
 * Every explicit membership `userId` holds across `orgId`, keyed by space id.
 * One query for a whole listing — `GET /api/spaces` must not do a lookup per
 * space.
 */
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

/** Wire projection of a role reference — `null` when the caller has no role. */
export function toSpaceRoleWire(
  ref: SpaceRoleRef | null,
): { kind: "preset" | "custom"; key: string; name: string } | null {
  if (!ref) return null;
  if (ref.kind === "preset") return { kind: "preset", key: ref.preset, name: ref.preset };
  return { kind: "custom", key: ref.role.key, name: ref.role.name };
}
