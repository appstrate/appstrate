// SPDX-License-Identifier: Apache-2.0

/**
 * Space roles — the four shipped presets plus the org's own bundles
 * (RBAC spec §3.3, §6.2).
 *
 * Presets are constants, not rows, and are projected onto the same wire shape
 * as a bundle so one listing answers "what can I assign here". Their `id` is
 * `null`, which is what makes them un-addressable by the write routes.
 *
 * A permission the validator does not know is a REFUSAL, never a silent drop —
 * same posture as `validateScopes`: a role created with a typo would 403 on the
 * thing its author asked for and say nothing about why.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { orgInvitations, spaceMembers, spaceRoles } from "@appstrate/db/schema";
import { SPACE_ROLE_PRESETS, type SpaceRolePreset } from "@appstrate/core/permissions";
import { isUniqueViolation } from "../lib/db-helpers.ts";
import { conflict, invalidRequest, notFound } from "../lib/errors.ts";
import { prefixedId } from "../lib/ids.ts";
import { knownSpaceLevelPermissions, presetPermissions } from "../lib/permissions.ts";

/** One entry of `GET /api/roles`; `id` is null for a preset (it has no row). */
export interface SpaceRoleWire {
  object: "role";
  kind: "preset" | "custom";
  id: string | null;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  created_at: string | null;
  updated_at: string | null;
}

/** Fields a create or update carries; `description` is nullable, not absent. */
export interface SpaceRoleInput {
  key: string;
  name: string;
  description?: string | null;
  permissions: string[];
}

const PRESET_KEYS: ReadonlySet<string> = new Set<string>(SPACE_ROLE_PRESETS);

type SpaceRoleRow = typeof spaceRoles.$inferSelect;

function toWire(row: SpaceRoleRow): SpaceRoleWire {
  return {
    object: "role",
    kind: "custom",
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    permissions: [...row.permissions].sort(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
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
    created_at: null,
    updated_at: null,
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
 * Refuse an empty array, or one naming a string the platform does not know.
 * The FIRST unknown is named: the array is authored in a picker driven by
 * `GET /api/roles/vocabulary`, so one offender is enough to locate the mistake.
 */
function assertKnownPermissions(permissions: string[]): void {
  if (permissions.length === 0) {
    throw invalidRequest("A role must grant at least one permission", "permissions");
  }
  const known = knownSpaceLevelPermissions();
  const unknown = permissions.find((p) => !known.has(p));
  if (unknown !== undefined) {
    throw invalidRequest(
      `Unknown space-level permission '${unknown}'. ` +
        `See GET /api/roles/vocabulary for the permissions a role can hold.`,
      "permissions",
    );
  }
}

/**
 * The DB CHECK backs this, but a constraint violation is a 500 with a Postgres
 * string in it — the refusal has to name the reserved keys readably.
 */
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

/**
 * Custom bundles are unique per org on `key`. This read answers the common case
 * with the key in the message; the `(org_id, key)` unique index is what makes it
 * true, and {@link asKeyConflict} catches the race the read cannot.
 */
async function assertKeyFree(orgId: string, key: string, exceptId?: string): Promise<void> {
  const [taken] = await db
    .select({ id: spaceRoles.id })
    .from(spaceRoles)
    .where(and(eq(spaceRoles.orgId, orgId), eq(spaceRoles.key, key)))
    .limit(1);
  if (!taken || taken.id === exceptId) return;
  keyTaken(key);
}

/**
 * Turn the unique-index violation two concurrent writers can produce into the
 * same 409 the check-then-write path gives. Without it the loser of the race
 * gets a 500 carrying a Postgres constraint name.
 */
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
  assertKnownPermissions(input.permissions);
  await assertKeyFree(orgId, input.key);

  const [row] = await db
    .insert(spaceRoles)
    .values({
      id: prefixedId("srl"),
      orgId,
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      permissions: input.permissions,
      createdBy,
    })
    .returning()
    .catch((err: unknown) => asKeyConflict(err, input.key));
  return toWire(row!);
}

/**
 * `key` is patchable like the rest: a role is addressed by its `srl_` id
 * everywhere, so renaming the key moves no reference.
 */
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
  if (patch.permissions !== undefined) assertKnownPermissions(patch.permissions);

  const [row] = await db
    .update(spaceRoles)
    .set({
      ...(patch.key !== undefined ? { key: patch.key } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.permissions !== undefined ? { permissions: patch.permissions } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(spaceRoles.id, id), eq(spaceRoles.orgId, orgId)))
    .returning()
    .catch((err: unknown) => asKeyConflict(err, patch.key));
  if (!row) throw notFound(`Role '${id}' not found in this organization`);
  return toWire(row);
}

/**
 * Delete a bundle nobody holds. Two things hold one: an explicit `space_members`
 * row, and a PENDING invitation whose `space_assignments` name it — the second
 * has no FK (the assignments are JSONB), so deleting under it would strand the
 * invitee with an assignment that silently never applies on accept.
 *
 * Both counts are read HERE rather than left to the `ON DELETE RESTRICT` FK,
 * whose error text is a constraint name — a 500 naming neither the role nor how
 * many people would have lost access.
 */
export async function deleteSpaceRole(orgId: string, id: string): Promise<SpaceRoleWire> {
  const [row] = await db
    .select()
    .from(spaceRoles)
    .where(and(eq(spaceRoles.id, id), eq(spaceRoles.orgId, orgId)))
    .limit(1);
  if (!row) throw notFound(`Role '${id}' not found in this organization`);

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
  const memberCount = assigned[0]?.count ?? 0;
  const pendingInvitationCount = invited[0]?.count ?? 0;
  if (memberCount > 0 || pendingInvitationCount > 0) {
    throw conflict(
      "role_in_use",
      `Role '${row.key}' is still held by ${memberCount} space member(s) and ` +
        `${pendingInvitationCount} pending invitation(s). Reassign them before deleting it.`,
      { member_count: memberCount, pending_invitation_count: pendingInvitationCount },
    );
  }

  await db.delete(spaceRoles).where(and(eq(spaceRoles.id, id), eq(spaceRoles.orgId, orgId)));
  return toWire(row);
}
