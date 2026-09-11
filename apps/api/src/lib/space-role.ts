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
import { partitionSpacePermissions, presetPermissions, type Permission } from "./permissions.ts";

export interface SpaceAccessRow {
  id: string;
  visibility: SpaceVisibility;
  defaultRole: SpaceRolePreset;
  /** Set on a personal space — the ONE member it belongs to (RBAC spec §3.6). */
  ownerUserId: string | null;
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
 *
 * `callerId` is the USER whose personal spaces are reachable, or `null` when
 * the principal is not one: an API key (pinned to a space, and its creator's
 * private drafts are not its business) or an end-user. Every caller passes it
 * explicitly — a default would silently hand a key its creator's personal space.
 */
export function resolveSpaceRole(
  orgRole: OrgRole,
  space: SpaceAccessRow,
  memberRow: SpaceMemberRow | null,
  callerId: string | null,
): SpaceRoleRef | null {
  // FIRST LINE, before the org role: a personal space belongs to one member and
  // to nobody else (RBAC spec §3.6). An organization owner or admin gets
  // `null` here, and every caller renders that as 404 — the space is `private`,
  // so for them it does not exist. Converting it to a team space
  // (`POST /api/spaces/{id}/convert-to-team`) is the one way in, and it is
  // audited.
  //
  // The owner holds `admin` there — except a GUEST, who holds `operator`. A
  // guest is an external identity with no implicit reach into any space (§3.2),
  // invited to USE one thing; `admin` in their own space would let them author
  // and launch arbitrary agents on the organization's LLM budget, which is the
  // one thing their org role exists to withhold. `operator` is receive-and-run:
  // exactly what a space shared TO them is for.
  if (space.ownerUserId !== null) {
    if (space.ownerUserId !== callerId) return null;
    return { kind: "preset", preset: orgRole === "guest" ? "operator" : "admin" };
  }
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
 * A custom bundle is narrowed to what the running platform still understands
 * ({@link partitionSpacePermissions}), so a string that became unknown (module
 * unloaded) never reaches `Set.has`.
 *
 * A bundle whose every string became unknown grants nothing, and the holder
 * keeps an explicit membership that grants nothing: explicit beats implicit in
 * both directions, so it does NOT fall back to an open space's default role.
 * Falling back would hand someone MORE than their bundle names on the very
 * replica that understands it least.
 */
export function spacePermissions(ref: SpaceRoleRef | null): Set<Permission> {
  if (!ref) return new Set<Permission>();
  if (ref.kind === "preset") return presetPermissions(ref.preset);
  return partitionSpacePermissions(ref.role.permissions).granted;
}

/**
 * One indexed lookup on the composite PK, custom role joined in the same query.
 *
 * `executor` takes an open transaction handle so a caller that must read the
 * row and write it in one go does not read it on a second connection.
 */
export async function loadSpaceMember(
  spaceId: string,
  userId: string,
  executor: Pick<typeof db, "select"> = db,
): Promise<SpaceMemberRow | null> {
  const [row] = await executor
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
