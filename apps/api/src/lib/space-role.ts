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
import { db } from "@appstrate/db/client";
import { organizations, spaceMembers, spaceRoles, spaces } from "@appstrate/db/schema";
import {
  isSpaceRolePreset,
  type OrgRole,
  type SpaceRolePreset,
  type SpaceVisibility,
} from "@appstrate/core/permissions";
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

/**
 * Two shapes, not one string: the DB stores presets under a CHECK and customs under an FK.
 * `plus` adds permissions on top of either — the personal-space delete floor rides on it.
 */
export type SpaceRoleRef =
  | { kind: "preset"; preset: SpaceRolePreset; plus?: readonly Permission[] }
  | { kind: "custom"; role: CustomSpaceRole; plus?: readonly Permission[] };

export const ADMIN_ROLE_REF: SpaceRoleRef = { kind: "preset", preset: "admin" };

/**
 * Granted on top of the role short of `admin` an owner holds in their own personal space through
 * an override or the org default, so nothing they already own there becomes impossible to stop
 * or remove (RBAC spec §3.6). A guest capped to `operator` holds none of it.
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
  const plus = [...new Set([...(ref.plus ?? []), ...PERSONAL_CAP_DELETE_PERMISSIONS])];
  return { ...ref, plus };
}

/**
 * The org's `personal_space_role` setting, read from the SAME statement as the space (RBAC
 * spec §4.4): joined on `organizations`, never cached. The stored value is a preset key or the
 * id of one of the org's custom roles; the custom role is resolved by a scalar subquery scoped
 * to `organizations.id`, so every snapshot reader selects these two columns and writes no join.
 * Aliased `psr` so it never binds to a `space_roles` the outer query joins for the membership.
 */
export const PERSONAL_SPACE_DEFAULT_COLUMNS = {
  storedPersonalSpaceRole: sql<string | null>`${organizations.orgSettings}->>'personal_space_role'`,
  personalSpaceCustomRole: sql<unknown>`(SELECT json_build_object('id', psr.id, 'key', psr.key, 'name', psr.name, 'permissions', psr.permissions) FROM space_roles psr WHERE psr.id = ${organizations.orgSettings}->>'personal_space_role' AND psr.org_id = ${organizations.id})`,
} as const;

interface PersonalSpaceDefaultColumns {
  storedPersonalSpaceRole: string | null;
  personalSpaceCustomRole: unknown;
}

/** Both drivers decode `json` (PGlite, postgres.js), so the subquery arrives as an object or `null`. */
function toCustomSpaceRole(value: unknown): CustomSpaceRole | null {
  if (value === null || typeof value !== "object") return null;
  const { id, key, name, permissions } = value as Record<string, unknown>;
  if (typeof id !== "string" || typeof key !== "string" || typeof name !== "string") return null;
  if (!Array.isArray(permissions) || !permissions.every((p) => typeof p === "string")) return null;
  return { id, key, name, permissions };
}

/**
 * The org default for a member's own personal space, before the floor. Absent = `admin`. A value
 * naming no role of the org (a custom role deleted in a race, a stray stored string) is
 * fail-closed: `viewer`, the narrowest preset, never `admin`.
 */
export function personalSpaceDefaultRef(row: PersonalSpaceDefaultColumns): SpaceRoleRef {
  const stored = row.storedPersonalSpaceRole;
  if (stored === null) return ADMIN_ROLE_REF;
  if (isSpaceRolePreset(stored)) return { kind: "preset", preset: stored };
  const custom = toCustomSpaceRole(row.personalSpaceCustomRole);
  if (custom) return { kind: "custom", role: custom };
  return { kind: "preset", preset: "viewer" };
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
 * never coexisted and grant what neither did. `personalSpaceDefault` is the
 * org's `personal_space_role` ({@link personalSpaceDefaultRef}), read in that same
 * statement; only the owner branch reads it.
 */
export function resolveSpaceRole(
  orgRole: OrgRole,
  space: SpaceAccessRow,
  memberRow: SpaceMemberRow | null,
  callerId: string | null,
  personalSpaceDefault: SpaceRoleRef,
): SpaceRoleRef | null {
  // FIRST LINE, before the org role: a personal space belongs to one member and
  // to nobody else (RBAC spec §3.6). An organization owner or admin gets
  // `null` here, and every caller renders that as 404 — converting it to a team
  // space (`POST /api/spaces/{id}/convert-to-team`) is the one way in, and it is
  // audited.
  //
  // The owner: an org owner or admin always holds `admin`. Anyone else holds, in
  // order, their own explicit row on the space (the per-member override, written
  // only by `PUT /api/orgs/{orgId}/members/{userId}/personal-space-role`), else the
  // org default. A GUEST (an external identity invited to USE one thing, not to
  // author agents on the organization's LLM budget) takes the default too, unless
  // it lets them author agents (`agents:write`: the `admin` and `builder` presets,
  // or a custom role granting it), in which case they hold plain `operator`; a
  // narrower default applies to them as to a member. The override, and the default as a
  // member or guest takes it, carry the delete floor short of `admin`, so the
  // owner can still stop and remove what they own; the guest's `operator` does not.
  if (space.ownerUserId !== null) {
    if (space.ownerUserId !== callerId) return null;
    if (orgRole === "owner" || orgRole === "admin") return ADMIN_ROLE_REF;
    if (memberRow) return withPersonalSpaceFloor(memberRow.ref);
    if (orgRole === "guest" && spacePermissions(personalSpaceDefault).has("agents:write")) {
      return { kind: "preset", preset: "operator" };
    }
    return withPersonalSpaceFloor(personalSpaceDefault);
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
  // `plus` is added AFTER the custom bundle is partitioned: it is the platform's own grant
  // (the personal-space floor), never a string a stored bundle could carry.
  const granted =
    ref.kind === "preset"
      ? presetPermissions(ref.preset)
      : partitionSpacePermissions(ref.role.permissions).granted;
  for (const permission of ref.plus ?? []) granted.add(permission);
  return granted;
}

/** Explicit-membership projection; joined onto `spaces` via {@link membershipOn} (RBAC spec §4.4). */
export const MEMBERSHIP_COLUMNS = {
  presetRole: spaceMembers.presetRole,
  customRoleId: spaceMembers.customRoleId,
  customKey: spaceRoles.key,
  customName: spaceRoles.name,
  customPermissions: spaceRoles.permissions,
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
