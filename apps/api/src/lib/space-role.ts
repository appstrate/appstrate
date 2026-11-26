// SPDX-License-Identifier: Apache-2.0

/**
 * Which role a principal holds in one space, and what it grants.
 *
 * Free of Hono and of the request pipeline on purpose: the SSE routes run
 * outside the pipeline and must share this implementation, not a second one.
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md §4
 */

import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "./db-helpers.ts";
import { ApiError } from "./errors.ts";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@appstrate/db/client";
import { organizations, spaceMembers, spaceRoles, spaces } from "@appstrate/db/schema";
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
  /** Resolves `studio:read` (RBAC spec §3.3). */
  showsStudio: boolean;
}

/** Two shapes, not one string: the DB stores presets under a CHECK and customs under an FK. */
export type SpaceRoleRef = (
  { kind: "preset"; preset: SpaceRolePreset } | { kind: "custom"; role: CustomSpaceRole }
) & { within?: readonly Permission[]; plus?: readonly Permission[] };

export const ADMIN_ROLE_REF: Readonly<SpaceRoleRef> = Object.freeze({
  kind: "preset",
  preset: "admin",
});

/**
 * Granted on top of the role an owner holds in their own personal space short of `admin`, so
 * nothing they already own there becomes impossible to stop or remove (RBAC spec §3.6).
 */
export const PERSONAL_CAP_DELETE_PERMISSIONS: readonly Permission[] = [
  "agents:delete",
  "skills:delete",
  "integrations:delete",
  "schedules:delete",
];

/** `ref` with the personal-space floor added; `admin` already holds it. */
function withPersonalSpaceFloor(ref: SpaceRoleRef): SpaceRoleRef {
  if (ref.kind === "preset" && ref.preset === "admin") return ref;
  return { ...ref, plus: PERSONAL_CAP_DELETE_PERMISSIONS };
}

/** A guest's share of `chosen`: within `operator` (a guest USES, never authors), then the floor. */
function guestPersonalRole(chosen: SpaceRoleRef): SpaceRoleRef {
  const operator = presetPermissions("operator");
  const granted = spacePermissions(chosen);
  const within = [...granted].filter((permission) => operator.has(permission));
  if (within.length === operator.size) {
    return withPersonalSpaceFloor({ kind: "preset", preset: "operator" });
  }
  if (within.length === granted.size) return withPersonalSpaceFloor(chosen);
  return withPersonalSpaceFloor({ ...chosen, within });
}

/** The org's custom personal-space default, aliased apart from an outer `space_roles` join. */
export const psr = alias(spaceRoles, "psr");

export const PERSONAL_SPACE_DEFAULT_COLUMNS = {
  storedPersonalSpaceRole: sql<SpaceRolePreset | null>`${organizations.orgSettings}->>'personal_space_role'`,
  personalDefaultRoleId: psr.id,
  personalDefaultKey: psr.key,
  personalDefaultName: psr.name,
  personalDefaultPermissions: psr.permissions,
  personalDefaultShowsStudio: psr.showsStudio,
} as const;

export const personalSpaceDefaultOn = eq(psr.id, organizations.personalSpaceRoleId);

export interface PersonalSpaceDefaultColumns {
  storedPersonalSpaceRole: SpaceRolePreset | null;
  personalDefaultRoleId: string | null;
  personalDefaultKey: string | null;
  personalDefaultName: string | null;
  personalDefaultPermissions: string[] | null;
  personalDefaultShowsStudio: boolean | null;
}

/** The org default, before the floor: the custom role, else the preset, else `admin`. */
export function personalSpaceDefaultRef(row: PersonalSpaceDefaultColumns): SpaceRoleRef {
  if (row.personalDefaultRoleId !== null) {
    return toRef({
      presetRole: null,
      customRoleId: row.personalDefaultRoleId,
      customKey: row.personalDefaultKey,
      customName: row.personalDefaultName,
      customPermissions: row.personalDefaultPermissions,
      customShowsStudio: row.personalDefaultShowsStudio,
    });
  }
  const stored = row.storedPersonalSpaceRole;
  return stored === null ? ADMIN_ROLE_REF : { kind: "preset", preset: stored };
}

/** What an owner holds in their own personal space once the role is chosen (override or default). */
function personalSpaceRoleOf(orgRole: "member" | "guest", chosen: SpaceRoleRef): SpaceRoleRef {
  return orgRole === "guest" ? guestPersonalRole(chosen) : withPersonalSpaceFloor(chosen);
}

/** What a member holds in their own personal space by the org default alone (RBAC spec §3.6). */
export function defaultPersonalSpaceRole(orgRole: OrgRole, orgDefault: SpaceRoleRef): SpaceRoleRef {
  if (orgRole === "owner" || orgRole === "admin") return ADMIN_ROLE_REF;
  return personalSpaceRoleOf(orgRole, orgDefault);
}

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
 *
 * `space` and `memberRow` MUST come from ONE statement, `orgRole` from the
 * request's admission (RBAC spec §4.4): read apart, they can pair states that
 * never coexisted and grant what neither did. Same for `personalDefault` (`null`: a team space).
 */
export function resolveSpaceRole(
  orgRole: OrgRole,
  space: SpaceAccessRow,
  memberRow: SpaceMemberRow | null,
  callerId: string | null,
  personalDefault: PersonalSpaceDefaultColumns | null,
): SpaceRoleRef | null {
  // FIRST LINE, before the org role: a personal space belongs to one member and
  // to nobody else (RBAC spec §3.6). An organization owner or admin gets
  // `null` here, and every caller renders that as 404 — converting it to a team
  // space (`POST /api/spaces/{id}/convert-to-team`) is the one way in, and it is
  // audited.
  //
  // The owner: `admin` for an org owner or admin, else their override or the org default.
  if (space.ownerUserId !== null) {
    if (space.ownerUserId !== callerId) return null;
    if (orgRole === "owner" || orgRole === "admin") return ADMIN_ROLE_REF;
    if (!personalDefault) {
      throw new Error(
        `resolveSpaceRole: personal space '${space.id}' resolved without the org's personal-space default`,
      );
    }
    return personalSpaceRoleOf(
      orgRole,
      memberRow ? memberRow.ref : personalSpaceDefaultRef(personalDefault),
    );
  }
  // By org role, which is why an explicit row for them is refused at write.
  if (orgRole === "owner" || orgRole === "admin") return ADMIN_ROLE_REF;
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
  // (base ∩ within) ∪ plus. A custom role's `studio:read` comes from its column, never its array.
  let granted: Set<Permission>;
  if (ref.kind === "preset") {
    granted = presetPermissions(ref.preset);
  } else {
    granted = partitionSpacePermissions(ref.role.permissions).granted;
    if (ref.role.showsStudio) granted.add("studio:read");
  }
  if (ref.within) {
    const within = new Set(ref.within);
    granted = new Set([...granted].filter((permission) => within.has(permission)));
  }
  for (const permission of ref.plus ?? []) granted.add(permission);
  return granted;
}

/** One org custom role, share-locked until commit against `deleteSpaceRole`; 404 when none. */
export async function lockOrgSpaceRole(
  tx: DbOrTx,
  orgId: string,
  roleId: string,
  param?: string,
): Promise<CustomSpaceRole> {
  const [role] = await tx
    .select({
      id: spaceRoles.id,
      key: spaceRoles.key,
      name: spaceRoles.name,
      permissions: spaceRoles.permissions,
      showsStudio: spaceRoles.showsStudio,
    })
    .from(spaceRoles)
    .where(and(eq(spaceRoles.id, roleId), eq(spaceRoles.orgId, orgId)))
    .limit(1)
    .for("key share");
  if (!role) {
    throw new ApiError({
      status: 404,
      code: "not_found",
      title: "Not Found",
      detail: `Space role '${roleId}' not found in this organization`,
      ...(param ? { param } : {}),
    });
  }
  return role;
}

/** Explicit-membership projection; joined onto `spaces` via {@link membershipOn} (RBAC spec §4.4). */
export const MEMBERSHIP_COLUMNS = {
  presetRole: spaceMembers.presetRole,
  customRoleId: spaceMembers.customRoleId,
  customKey: spaceRoles.key,
  customName: spaceRoles.name,
  customPermissions: spaceRoles.permissions,
  customShowsStudio: spaceRoles.showsStudio,
} as const;

/** `spaces LEFT JOIN space_members ON` this — `null` joins nothing (a principal with no rows). */
export function membershipOn(userId: string | null) {
  return and(
    eq(spaceMembers.spaceId, spaces.id),
    userId === null ? sql`false` : eq(spaceMembers.userId, userId),
  );
}

export const customRoleOn = eq(spaceRoles.id, spaceMembers.customRoleId);

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
    .select(MEMBERSHIP_COLUMNS)
    .from(spaceMembers)
    .leftJoin(spaceRoles, customRoleOn)
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
  customShowsStudio: boolean | null;
}

/** The `num_nonnulls` CHECK and the FK are what the assertions rest on. */
function toRef(row: MembershipColumns): SpaceRoleRef {
  if (row.presetRole) return { kind: "preset", preset: row.presetRole };
  return {
    kind: "custom",
    role: {
      id: row.customRoleId!,
      key: row.customKey!,
      name: row.customName!,
      permissions: row.customPermissions!,
      showsStudio: row.customShowsStudio!,
    },
  };
}

/** The row a `LEFT JOIN` found, or `null` — the `num_nonnulls` CHECK sets one role column on a real row. */
export function memberFromJoin(row: MembershipColumns): SpaceMemberRow | null {
  return row.presetRole !== null || row.customRoleId !== null ? { ref: toRef(row) } : null;
}

export function toSpaceRoleWire(
  ref: SpaceRoleRef | null,
): { kind: "preset" | "custom"; key: string; name: string } | null {
  if (!ref) return null;
  if (ref.kind === "preset") return { kind: "preset", key: ref.preset, name: ref.preset };
  return { kind: "custom", key: ref.role.key, name: ref.role.name };
}
