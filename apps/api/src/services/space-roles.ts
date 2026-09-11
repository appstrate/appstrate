// SPDX-License-Identifier: Apache-2.0

/**
 * The four shipped presets plus the org's own bundles (RBAC spec §3.3, §6.2).
 *
 * Presets are constants projected onto the bundle wire shape, so one listing
 * answers "what can I assign here"; their `null` id is what makes them
 * un-addressable by the write routes.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { orgInvitations, spaceMembers, spaceRoles } from "@appstrate/db/schema";
import { SPACE_ROLE_PRESETS, type SpaceRolePreset } from "@appstrate/core/permissions";
import { isForeignKeyViolation, isUniqueViolation } from "../lib/db-helpers.ts";
import { getAppConfig } from "../lib/app-config.ts";
import { ApiError, conflict, invalidRequest, notFound } from "../lib/errors.ts";
import { prefixedId } from "../lib/ids.ts";
import {
  knownSpaceLevelPermissions,
  partitionSpacePermissions,
  presetPermissions,
} from "../lib/permissions.ts";

/** One entry of `GET /api/roles`; `id` is null for a preset (it has no row). */
export interface SpaceRoleWire {
  object: "role";
  kind: "preset" | "custom";
  id: string | null;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  /**
   * Stored entries this deployment cannot name — always empty for a preset.
   * Never part of `permissions`: the two are what the role grants and what it
   * merely spells here.
   */
  unavailable_permissions: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

/** Fields a create or update carries; `description` is nullable, not absent. */
export interface SpaceRoleInput {
  key: string;
  name: string;
  description?: string | null;
  permissions: string[];
}

const PRESET_KEYS: ReadonlySet<string> = new Set<string>(SPACE_ROLE_PRESETS);

/**
 * Does this deployment define custom space roles at all (RBAC spec §9)? Read
 * per call, not captured: modules merge their features into `AppConfig` at boot.
 *
 * The predicate, not the refusal, is what the two callers share — the write
 * routes answer `feature_unavailable`, the role preview answers
 * `view_as_forbidden` (a client must recognise every persona refusal as "drop
 * the preview"). Sharing the predicate is what keeps "can this deployment do
 * custom roles" one question with one answer.
 */
export function hasCustomRoles(): boolean {
  return getAppConfig().features.custom_roles === true;
}

/** What a refused call was about to do, so the 403 names the act, not the flag. */
export type CustomRoleAct = "define" | "assign";

const ACT_DETAIL: Record<CustomRoleAct, string> = {
  define: "Defining a custom space role",
  assign: "Assigning a custom space role",
};

/**
 * {@link hasCustomRoles} as a refusal. Covers DEFINING and GRANTING a bundle —
 * either half alone is the feature. REMOVING one never asks, so a deployment
 * that loses the feature keeps exactly the verbs that shrink what leftover
 * bundles reach.
 */
export function assertCustomRolesFeature(act: CustomRoleAct): void {
  if (hasCustomRoles()) return;
  throw new ApiError({
    status: 403,
    code: "feature_unavailable",
    title: "Feature Unavailable",
    detail:
      `${ACT_DETAIL[act]} requires the \`custom_roles\` feature, provided by the ` +
      "Appstrate Cloud plan (the `@appstrate/module-ee` module). The built-in presets " +
      `(${SPACE_ROLE_PRESETS.join(", ")}) are always available.`,
  });
}

type SpaceRoleRow = typeof spaceRoles.$inferSelect;

/**
 * `permissions` is what the bundle GRANTS here, projected through the same
 * narrowing enforcement uses, so an admin and a holder never read the platform
 * differently and the array a listing returns is one a `PATCH` accepts back.
 * What the row spells and this deployment cannot name is not dropped in
 * silence — it is `unavailable_permissions`, which is what makes a bundle
 * degraded by a module removal legible instead of merely shorter.
 */
function toWire(row: SpaceRoleRow): SpaceRoleWire {
  const { granted, unavailable } = partitionSpacePermissions(row.permissions);
  return {
    object: "role",
    kind: "custom",
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    permissions: [...granted].sort(),
    unavailable_permissions: unavailable.sort(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function presetWire(preset: SpaceRolePreset): SpaceRoleWire {
  return {
    object: "role",
    kind: "preset",
    id: null,
    key: preset,
    name: preset,
    description: null,
    permissions: [...presetPermissions(preset)].sort(),
    // A preset is code, not a row: nothing can be stored on it that the
    // deployment does not name.
    unavailable_permissions: [],
    createdAt: null,
    updatedAt: null,
  };
}

/** Presets (from code) then the org's bundles, ordered so the wire is stable. */
export async function listSpaceRoles(orgId: string): Promise<SpaceRoleWire[]> {
  const rows = await db
    .select()
    .from(spaceRoles)
    .where(eq(spaceRoles.orgId, orgId))
    .orderBy(spaceRoles.key);
  return [...SPACE_ROLE_PRESETS.map(presetWire), ...rows.map(toWire)];
}

/**
 * What a write actually stores: every entry known, each one once.
 *
 * An unknown permission is a REFUSAL, never a silent drop: a role created with
 * a typo would 403 on the thing its author asked for and say nothing about why.
 * Naming the first offender is enough — the array is authored in a picker.
 *
 * The vocabulary is also the array's ceiling, in both directions. The stored
 * array is re-walked on every request of every holder (`spacePermissions`, and
 * once per space in `GET /api/spaces`), so duplicates are collapsed here rather
 * than carried forever; a body longer than the whole vocabulary can hold
 * nothing but duplicates and is refused before it is walked.
 */
function normalizePermissions(permissions: string[]): string[] {
  const known = knownSpaceLevelPermissions();
  if (permissions.length > known.size) {
    throw invalidRequest(
      `A role can hold at most ${known.size} permissions — the whole vocabulary — ` +
        `and this list has ${permissions.length}. ` +
        `See GET /api/roles/vocabulary for the permissions a role can hold.`,
      "permissions",
    );
  }
  const granted = new Set<string>();
  for (const permission of permissions) {
    if (!known.has(permission)) {
      throw invalidRequest(
        `Unknown space-level permission '${permission}'. ` +
          `See GET /api/roles/vocabulary for the permissions a role can hold.`,
        "permissions",
      );
    }
    granted.add(permission);
  }
  if (granted.size === 0) {
    throw invalidRequest("A role must grant at least one permission", "permissions");
  }
  return [...granted];
}

/** The DB CHECK backs this; a constraint violation would be a 500 naming nothing readable. */
function assertNotPresetKey(key: string): void {
  if (!PRESET_KEYS.has(key)) return;
  throw invalidRequest(
    `'${key}' is a built-in preset and cannot be redefined. ` +
      `Reserved keys: ${SPACE_ROLE_PRESETS.join(", ")}.`,
    "key",
  );
}

function keyTaken(key: string): never {
  throw conflict("role_key_taken", `A role with key '${key}' already exists in this organization`);
}

/** The `(org_id, key)` index is the truth; this read just gives a readable 409, and {@link asKeyConflict} catches the race. */
async function assertKeyFree(orgId: string, key: string, exceptId?: string): Promise<void> {
  const [taken] = await db
    .select({ id: spaceRoles.id })
    .from(spaceRoles)
    .where(and(eq(spaceRoles.orgId, orgId), eq(spaceRoles.key, key)))
    .limit(1);
  if (!taken || taken.id === exceptId) return;
  keyTaken(key);
}

/** The loser of a write race gets the same 409, not a 500 carrying a constraint name. */
function asKeyConflict(err: unknown, key: string | undefined): never {
  if (key !== undefined && isUniqueViolation(err)) keyTaken(key);
  throw err;
}

export async function createSpaceRole(params: {
  orgId: string;
  createdBy: string;
  input: SpaceRoleInput;
}): Promise<SpaceRoleWire> {
  const { orgId, createdBy, input } = params;
  assertNotPresetKey(input.key);
  const permissions = normalizePermissions(input.permissions);
  await assertKeyFree(orgId, input.key);

  const [row] = await db
    .insert(spaceRoles)
    .values({
      id: prefixedId("srl"),
      orgId,
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      permissions,
      createdBy,
    })
    .returning()
    .catch((err: unknown) => asKeyConflict(err, input.key));
  return toWire(row!);
}

/** `key` is patchable: a role is addressed by `srl_` id everywhere, so a rename moves no reference. */
export async function updateSpaceRole(params: {
  orgId: string;
  id: string;
  patch: Partial<SpaceRoleInput>;
}): Promise<SpaceRoleWire> {
  const { orgId, id, patch } = params;
  if (patch.key !== undefined) {
    assertNotPresetKey(patch.key);
    await assertKeyFree(orgId, patch.key, id);
  }
  const permissions =
    patch.permissions !== undefined ? normalizePermissions(patch.permissions) : undefined;

  const [row] = await db
    .update(spaceRoles)
    .set({
      ...(patch.key !== undefined ? { key: patch.key } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(permissions !== undefined ? { permissions } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(spaceRoles.id, id), eq(spaceRoles.orgId, orgId)))
    .returning()
    .catch((err: unknown) => asKeyConflict(err, patch.key));
  if (!row) throw notFound(`Role '${id}' not found in this organization`);
  return toWire(row);
}

/**
 * Two things hold a bundle: a `space_members` row, and a PENDING invitation
 * whose JSONB `space_assignments` name it. The second has no FK, so deleting
 * under it would strand the invitee with an assignment that never applies.
 */
async function countRoleHolders(
  orgId: string,
  id: string,
): Promise<{ memberCount: number; pendingInvitationCount: number }> {
  const [assigned, invited] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(spaceMembers)
      .where(eq(spaceMembers.customRoleId, id)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(orgInvitations)
      .where(
        and(
          eq(orgInvitations.orgId, orgId),
          eq(orgInvitations.status, "pending"),
          // JSONB containment: the assignments array holds an entry naming
          // this role. One predicate for an array of objects, no unnest.
          sql`${orgInvitations.spaceAssignments} @> ${JSON.stringify([{ custom_role_id: id }])}::jsonb`,
        ),
      ),
  ]);
  return {
    memberCount: assigned[0]?.count ?? 0,
    pendingInvitationCount: invited[0]?.count ?? 0,
  };
}

function roleInUse(
  key: string,
  counts: { memberCount: number; pendingInvitationCount: number },
): never {
  throw conflict(
    "role_in_use",
    `Role '${key}' is still held by ${counts.memberCount} space member(s) and ` +
      `${counts.pendingInvitationCount} pending invitation(s). Reassign them before deleting it.`,
    {
      member_count: counts.memberCount,
      pending_invitation_count: counts.pendingInvitationCount,
    },
  );
}

/**
 * The loser of a delete/assign race gets the same 409 as the pre-count, not a
 * 500 naming a constraint — the same shape {@link asKeyConflict} gives the
 * create/update races. `space_members.custom_role_id` is ON DELETE RESTRICT,
 * so an assignment landing between the count and the delete fires the
 * referential-integrity violation; recount to name who now holds the role.
 */
async function asRoleInUse(err: unknown, orgId: string, id: string, key: string): Promise<never> {
  if (!isForeignKeyViolation(err)) throw err;
  roleInUse(key, await countRoleHolders(orgId, id));
}

/**
 * Holders are counted rather than left to `ON DELETE RESTRICT`, whose error
 * names neither the role nor how many people would lose access. The count is
 * lock-free on purpose: {@link asRoleInUse} turns the race it leaves open into
 * the very same 409, so the delete never has to hold a lock to be honest.
 */
export async function deleteSpaceRole(orgId: string, id: string): Promise<SpaceRoleWire> {
  const [row] = await db
    .select()
    .from(spaceRoles)
    .where(and(eq(spaceRoles.id, id), eq(spaceRoles.orgId, orgId)))
    .limit(1);
  if (!row) throw notFound(`Role '${id}' not found in this organization`);

  const counts = await countRoleHolders(orgId, id);
  if (counts.memberCount > 0 || counts.pendingInvitationCount > 0) roleInUse(row.key, counts);

  await db
    .delete(spaceRoles)
    .where(and(eq(spaceRoles.id, id), eq(spaceRoles.orgId, orgId)))
    .catch((err: unknown) => asRoleInUse(err, orgId, id, row.key));
  return toWire(row);
}
