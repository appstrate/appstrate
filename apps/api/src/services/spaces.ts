// SPDX-License-Identifier: Apache-2.0

import { eq, asc, desc } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import { db } from "@appstrate/db/client";
import { spaces, files, uploads, runs, organizations } from "@appstrate/db/schema";
import { invalidRequest, notFound } from "../lib/errors.ts";
import { prefixedId } from "../lib/ids.ts";
import { scopedWhere } from "../lib/db-helpers.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { enqueueStorageDeletion, type StorageDeletionJobInput } from "./storage-deletion.ts";
import { decrementOrgFileBytes, storageKeyToDeletionJob } from "./files.ts";
import { runWorkspaceDeletionJobs } from "./run-workspace-storage.ts";
import type { OrgRole, SpaceRolePreset, SpaceVisibility } from "@appstrate/core/permissions";
import { loadSpaceMemberships, resolveSpaceRole, type SpaceRoleRef } from "../lib/space-role.ts";

type SpaceRow = InferSelectModel<typeof spaces>;

export const spaceSettingsSchema = z.object({
  allowedRedirectDomains: z.array(z.string()).max(20).optional(),
});

type SpaceSettings = z.infer<typeof spaceSettingsSchema>;

/**
 * Every space of `orgId` the caller reaches, with their role in each
 * (RBAC spec §6.3). One query for the spaces and one for the caller's whole
 * membership set — never one lookup per space.
 *
 * Owner/admin see all; a `member` additionally sees `closed` spaces they
 * cannot enter (so they know to ask); a `guest` and a `private` space both
 * need an explicit row. The filtering is the listing's, not the resolver's:
 * `resolveSpaceRole` answers "what role", this answers "which spaces".
 */
export async function listSpacesForPrincipal(
  orgId: string,
  orgRole: OrgRole,
  userId: string,
): Promise<Array<{ space: SpaceRow; role: SpaceRoleRef | null }>> {
  const [rows, memberships] = await Promise.all([
    listSpaces(orgId),
    loadSpaceMemberships(orgId, userId),
  ]);
  const out: Array<{ space: SpaceRow; role: SpaceRoleRef | null }> = [];
  for (const space of rows) {
    const role = resolveSpaceRole(orgRole, space, memberships.get(space.id) ?? null);
    if (!isSpaceVisibleTo(orgRole, space, role)) continue;
    out.push({ space, role });
  }
  return out;
}

/**
 * May this caller know that this space exists? (RBAC spec §6.3.)
 *
 * ONE function, two call sites — the listing above and `GET /api/spaces/:id`.
 * Split, they drift, and the drift is silent in exactly one direction: a
 * by-id read that is more permissive than the listing hands out the spaces the
 * listing was written to hide.
 *
 * A role of its own always makes a space visible. Without one, a single case
 * remains: a `closed` space, to a `member`, so they know it exists and can ask
 * for it. A `private` space is invisible, and a `guest` sees only what it was
 * explicitly added to — "org users" and "space members" being two different
 * things is the whole reason `guest` exists.
 */
export function isSpaceVisibleTo(
  orgRole: OrgRole,
  space: { visibility: SpaceVisibility },
  role: SpaceRoleRef | null,
): boolean {
  if (role) return true;
  return orgRole === "member" && space.visibility === "closed";
}

/** Create a new space for an organization. */
export async function createSpace(
  orgId: string,
  params: { name: string; settings?: SpaceSettings; isDefault?: boolean },
  createdBy?: string,
) {
  const id = prefixedId("spc");
  const [space] = await db
    .insert(spaces)
    .values({
      id,
      orgId,
      name: params.name,
      isDefault: params.isDefault ?? false,
      settings: params.settings ?? {},
      createdBy: createdBy ?? null,
    })
    .returning();

  return space!;
}

/**
 * Create the default space for an organization.
 * Returns the existing default if one already exists (idempotent).
 */
export async function createDefaultSpace(orgId: string, createdBy?: string) {
  const existing = await db
    .select()
    .from(spaces)
    .where(scopedWhere(spaces, { orgId, extra: [eq(spaces.isDefault, true)] }))
    .limit(1);

  if (existing[0]) return existing[0];

  return createSpace(orgId, { name: "Default", isDefault: true }, createdBy);
}

/**
 * All spaces of an organization, ordered by creation date (newest first).
 * Deliberately NOT exported: every caller must go through
 * {@link listSpacesForPrincipal}, which is the one that applies §6.3 filtering
 * — a raw list handed to a route is a list nobody filtered.
 */
async function listSpaces(orgId: string) {
  return db
    .select()
    .from(spaces)
    .where(eq(spaces.orgId, orgId))
    .orderBy(desc(spaces.isDefault), asc(spaces.createdAt));
}

/** Get a single space by ID, verifying org ownership. Throws 404 if not found. */
export async function getSpace(orgId: string, spaceId: string) {
  const [space] = await db
    .select()
    .from(spaces)
    .where(scopedWhere(spaces, { orgId, extra: [eq(spaces.id, spaceId)] }))
    .limit(1);

  if (!space) throw notFound("Space not found");
  return space;
}

/** Verify a space id belongs to the current org-scoped request. */
export async function assertSpaceInScope(scope: SpaceScope): Promise<void> {
  const [space] = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(
      scopedWhere(spaces, {
        orgId: scope.orgId,
        extra: [eq(spaces.id, scope.spaceId)],
      }),
    )
    .limit(1);

  if (!space) {
    throw notFound(`Space '${scope.spaceId}' not found in this organization`);
  }
}

/** Update a space. Throws 404 if not found. */
export async function updateSpace(
  orgId: string,
  spaceId: string,
  params: {
    name?: string;
    settings?: SpaceSettings;
    visibility?: SpaceVisibility;
    defaultRole?: SpaceRolePreset;
  },
) {
  // The DB check backs this, but a 400 naming the rule beats a 23514.
  if (params.visibility !== undefined && params.visibility !== "open") {
    const current = await getSpace(orgId, spaceId);
    if (current.isDefault) {
      throw invalidRequest(
        "The default space must stay open — every org member lands there.",
        "visibility",
      );
    }
  }
  const [space] = await db
    .update(spaces)
    .set({
      ...(params.name !== undefined && { name: params.name }),
      ...(params.settings !== undefined && { settings: params.settings }),
      ...(params.visibility !== undefined && { visibility: params.visibility }),
      ...(params.defaultRole !== undefined && { defaultRole: params.defaultRole }),
      updatedAt: new Date(),
    })
    .where(scopedWhere(spaces, { orgId, extra: [eq(spaces.id, spaceId)] }))
    .returning();

  if (!space) throw notFound("Space not found");
  return space;
}

/** Delete a space. Throws 400 if default, 404 if not found. */
export async function deleteSpace(orgId: string, spaceId: string) {
  await db.transaction(async (tx) => {
    // Use the same org-first lock order as file/upload writes, then lock the
    // parent space before enumerating its children. The parent lock
    // prevents a concurrent FK insert from being cascade-deleted without a
    // matching outbox job.
    const [org] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
      .for("update");
    if (!org) throw notFound("Space not found");

    const [space] = await tx
      .select({ id: spaces.id, isDefault: spaces.isDefault })
      .from(spaces)
      .where(scopedWhere(spaces, { orgId, extra: [eq(spaces.id, spaceId)] }))
      .limit(1)
      .for("update");
    if (!space) throw notFound("Space not found");
    if (space.isDefault) throw invalidRequest("Cannot delete default space");

    const docRows = await tx
      .select({ storageKey: files.storageKey, size: files.size })
      .from(files)
      .where(eq(files.spaceId, spaceId));
    const uploadRows = await tx
      .select({ storageKey: uploads.storageKey })
      .from(uploads)
      .where(eq(uploads.spaceId, spaceId));
    const runRows = await tx.select({ id: runs.id }).from(runs).where(eq(runs.spaceId, spaceId));

    const storageJobs: StorageDeletionJobInput[] = [];
    for (const r of [...docRows, ...uploadRows]) {
      const job = storageKeyToDeletionJob(r.storageKey, "space_deleted");
      if (job) storageJobs.push(job);
    }
    for (const r of runRows) {
      storageJobs.push(...runWorkspaceDeletionJobs(r.id, "space_deleted"));
    }
    // No package artifacts to enumerate here: `packages` is ORG-scoped (it has
    // no `space_id`), so this cascade drops only the `space_packages`
    // join rows — the `agent-packages` / `library-packages` objects stay owned
    // by the org and are purged by `deleteOrganization`. Verified against
    // `packages/db/src/schema/packages.ts`.
    await enqueueStorageDeletion(tx, storageJobs);

    const bytes = docRows.reduce((sum, row) => sum + row.size, 0);
    if (bytes > 0) await decrementOrgFileBytes(tx, orgId, bytes);

    const deleted = await tx
      .delete(spaces)
      .where(scopedWhere(spaces, { orgId, extra: [eq(spaces.id, spaceId)] }))
      .returning({ id: spaces.id });
    if (deleted.length === 0) throw notFound("Space not found");
  });
}
