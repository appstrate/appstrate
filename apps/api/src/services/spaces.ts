// SPDX-License-Identifier: Apache-2.0

import { and, asc, desc, eq, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import { db } from "@appstrate/db/client";
import {
  files,
  organizations,
  packages,
  runs,
  spacePackages,
  spaces,
  uploads,
} from "@appstrate/db/schema";
import { conflict, invalidRequest, notFound } from "../lib/errors.ts";
import { prefixedId } from "@appstrate/db/ids";
import { scopedWhere } from "../lib/db-helpers.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { enqueueStorageDeletion, type StorageDeletionJobInput } from "./storage-deletion.ts";
import { decrementOrgFileBytes, storageKeyToDeletionJob } from "./files.ts";
import { runWorkspaceDeletionJobs } from "./run-workspace-storage.ts";
import { packageStorageDeletionJobs } from "./package-storage-deletion.ts";
import { countInProgressRuns } from "./state/runs.ts";
import { DEFAULT_SPACE_NAME, ensurePersonalSpace } from "@appstrate/db/provision-org";
import type { OrgRole, SpaceRolePreset, SpaceVisibility } from "@appstrate/core/permissions";
import {
  loadSpaceMemberships,
  resolveSpaceRole,
  type SpaceMemberRow,
  type SpaceRoleRef,
} from "../lib/space-role.ts";

type SpaceRow = InferSelectModel<typeof spaces>;

/** Accepts either the base client or an open transaction handle. */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const spaceSettingsSchema = z.object({
  allowedRedirectDomains: z.array(z.string()).max(20).optional(),
});

type SpaceSettings = z.infer<typeof spaceSettingsSchema>;

/**
 * Every space of `orgId` the caller reaches, with their role in each (RBAC spec
 * §6.3): one query for spaces, one for memberships, `isSpaceVisibleTo` filters.
 * `overlay` replaces the caller's own rows (role preview, `lib/view-as.ts`).
 */
export async function listSpacesForPrincipal(
  orgId: string,
  orgRole: OrgRole,
  userId: string,
  personalOwnerId: string | null,
  overlay?: ReadonlyMap<string, SpaceMemberRow>,
): Promise<Array<{ space: SpaceRow; role: SpaceRoleRef | null }>> {
  const administersOrg = orgRole === "owner" || orgRole === "admin";
  const [rows, memberships] = await Promise.all([
    listVisibleSpaces(orgId, personalOwnerId, administersOrg),
    overlay ?? loadSpaceMemberships(orgId, userId),
  ]);
  const out: Array<{ space: SpaceRow; role: SpaceRoleRef | null }> = [];
  for (const space of rows) {
    const role = resolveSpaceRole(
      orgRole,
      space,
      memberships.get(space.id) ?? null,
      personalOwnerId,
    );
    if (!isSpaceVisibleTo(orgRole, space, role)) continue;
    out.push({ space, role });
  }
  return out;
}

/**
 * May this caller know that this space exists? (RBAC spec §6.3.) ONE function
 * for the listing and `GET /api/spaces/:id`, so a by-id read can never be more
 * permissive than the listing. Own role: visible. Otherwise only a `closed`
 * space to a `member` (so they can ask); `private` is invisible and a `guest`
 * sees only what it was explicitly added to.
 *
 * One exception, and it is the whole administrative surface of §3.6: an
 * ORPHANED personal space — its owner left the organization — is listed to
 * owners and admins with `access: "none"`, because somebody has to decide
 * whether to convert it or sweep it before the 30-day window closes. A LIVE
 * personal space stays invisible to them.
 */
export function isSpaceVisibleTo(
  orgRole: OrgRole,
  space: { visibility: SpaceVisibility; ownerUserId: string | null; orphanedAt: Date | null },
  role: SpaceRoleRef | null,
): boolean {
  if (role) return true;
  if (space.ownerUserId !== null) {
    return space.orphanedAt !== null && (orgRole === "owner" || orgRole === "admin");
  }
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

  return createSpace(orgId, { name: DEFAULT_SPACE_NAME, isDefault: true }, createdBy);
}

/**
 * The spaces of `orgId` this principal may be SHOWN, narrowed in SQL.
 *
 * The personal-space half of §6.3 is a `WHERE` clause rather than a TS filter
 * because there is one personal space per member: reading the whole `spaces`
 * table and dropping the rows afterwards made every listing grow with the
 * organization's headcount. Three disjuncts, and they are exactly the three
 * ways a space can be shown (§3.6):
 *
 *   - a team space (`owner_user_id IS NULL`) — the ordinary case, still filtered
 *     by {@link isSpaceVisibleTo} for `closed` / `private`;
 *   - the caller's OWN personal space;
 *   - an ORPHANED personal space, to an organization owner or admin, who has to
 *     decide whether to convert or sweep it.
 *
 * NOT exported, and there is deliberately no unfiltered variant: a request path
 * that wanted "all spaces of the org" would be reading somebody's private
 * drafts. The sweeper reads its own narrower query
 * ({@link listSweepablePersonalSpaces}) and org deletion goes through the FK
 * cascade.
 */
async function listVisibleSpaces(
  orgId: string,
  personalOwnerId: string | null,
  administersOrg: boolean,
) {
  return db
    .select()
    .from(spaces)
    .where(
      and(
        eq(spaces.orgId, orgId),
        or(
          isNull(spaces.ownerUserId),
          personalOwnerId === null ? undefined : eq(spaces.ownerUserId, personalOwnerId),
          administersOrg ? isNotNull(spaces.orphanedAt) : undefined,
        ),
      ),
    )
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
  // Both rules are DB CHECKs too, but a named 4xx beats a 23514.
  if (params.visibility !== undefined || params.defaultRole !== undefined) {
    const current = await getSpace(orgId, spaceId);
    if (current.ownerUserId !== null) {
      // A personal space is `private` with one member by construction; there is
      // no visibility to choose and no implicit member to give a default role
      // to (RBAC spec §3.6). `name` stays editable, and `is_default` is not a
      // field of this route at all.
      throw conflict(
        "personal_space_immutable",
        "A personal space is always private and has no implicit members: only its name can be changed.",
      );
    }
    if (params.visibility !== undefined && params.visibility !== "open" && current.isDefault) {
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

/**
 * The refusal that keeps a personal space out of the administrative surface,
 * worded ONCE: {@link assertSpaceAdminAct} raises it for the route and
 * {@link deleteSpace} raises it again under the row lock, and a caller reading
 * two different sentences for the same rule would be reading a bug.
 */
function personalSpaceNotDeletable() {
  return conflict(
    "personal_space_not_deletable",
    "A personal space is deleted by offboarding, once its owner has left the organization. " +
      "Convert it to a team space to keep its contents.",
  );
}

/** The refusal every space deletion shares: the run cascade must not fire under a live container. */
function spaceHasActiveRuns() {
  return conflict(
    "space_has_active_runs",
    "Cannot delete this space while runs are in progress. Cancel them or wait for them to finish.",
  );
}

/**
 * Delete a space. Throws 400 if default, 404 if not found, 409 if it is the
 * home of any package (RBAC spec §6.9) or if it is a personal space and the
 * caller is not the sweeper (§3.6).
 *
 * `actor` is what separates `DELETE /api/spaces/{id}` from the offboarding
 * routine: a personal space is not an administrative object, and its owner
 * cannot delete it either (`spaces:delete` is org-level). It goes away when
 * its owner leaves and the 30-day window closes —
 * {@link emptyAndDeletePersonalSpace} — or after an admin converted it to a
 * team space.
 *
 * `tx` joins an OPEN transaction instead of opening one, the shape
 * `provisionMember(tx, …)` uses. {@link emptyAndDeletePersonalSpace} passes it
 * so that emptying the space and deleting it are one atomic act; every other
 * caller omits it and gets its own transaction. Passing a non-transactional
 * handle would run the enumerate-enqueue-delete sequence unatomically, which is
 * the whole thing this function is arranged to avoid.
 */
export async function deleteSpace(
  orgId: string,
  spaceId: string,
  actor: "request" | "sweeper" = "request",
  tx?: DbOrTx,
) {
  if (tx) {
    await deleteSpaceInTx(tx, orgId, spaceId, actor);
    return;
  }
  await db.transaction(async (inner) => deleteSpaceInTx(inner, orgId, spaceId, actor));
}

async function deleteSpaceInTx(
  tx: DbOrTx,
  orgId: string,
  spaceId: string,
  actor: "request" | "sweeper",
) {
  // Use the same org-first lock order as file/upload writes, then lock the
  // parent space before enumerating its children. The parent lock
  // prevents a concurrent FK insert from being cascade-deleted without a
  // matching outbox job. Re-taking a lock this transaction already holds is
  // free, so the sweeper's own preamble does not have to skip it.
  const [org] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
    .for("update");
  if (!org) throw notFound("Space not found");

  const [space] = await tx
    .select({
      id: spaces.id,
      isDefault: spaces.isDefault,
      ownerUserId: spaces.ownerUserId,
    })
    .from(spaces)
    .where(scopedWhere(spaces, { orgId, extra: [eq(spaces.id, spaceId)] }))
    .limit(1)
    .for("update");
  if (!space) throw notFound("Space not found");
  if (space.isDefault) throw invalidRequest("Cannot delete default space");
  if (space.ownerUserId !== null && actor !== "sweeper") {
    throw personalSpaceNotDeletable();
  }

  // Same rule as organization deletion, and the SAME predicate
  // (`countInProgressRuns`): this delete cascade-drops `runs`/`run_logs`, so
  // performing it while a run is executing rips the rows out from under a
  // live container — the run then writes to a row that is gone, and its
  // workspace objects are enqueued for deletion mid-flight. For EVERY actor,
  // the sweeper included: an orphaned space with a live run is a state to
  // wait out, and the sweeper logs the refusal and retries next pass.
  if ((await countInProgressRuns(tx, { orgId, spaceId })) > 0) {
    throw spaceHasActiveRuns();
  }

  // A homed package's write authority IS this space (`packages.home_space_id`,
  // `ON DELETE RESTRICT`), so the row cannot follow the space out. Re-homing
  // it here would silently widen or narrow who may edit it, and deleting it
  // would destroy a catalog entry other spaces are running. Name the packages
  // and let the caller move them: `PATCH /api/packages/{scope}/{name}`.
  // Inline shadow rows never appear here on their own: they carry no home at
  // all, so a run in this space cannot make it undeletable.
  const homed = await tx
    .select({ id: packages.id })
    .from(packages)
    .where(and(eq(packages.orgId, orgId), eq(packages.homeSpaceId, spaceId)))
    .orderBy(asc(packages.id));
  if (homed.length > 0) {
    throw conflict(
      "space_homes_packages",
      `Cannot delete this space: it is the home of ${homed.length} package(s) — ${homed
        .map((row) => row.id)
        .join(", ")}. Move them to another space first.`,
      { packages: homed.map((row) => row.id) },
    );
  }

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
  // No package artifacts to enumerate here. A package this space HOMED made
  // the delete a 409 above, so what the cascade still drops is only the
  // `space_packages` join rows of packages homed elsewhere — the
  // `agent-packages` / `library-packages` objects stay owned by the org and
  // are purged by `deleteOrganization`.
  await enqueueStorageDeletion(tx, storageJobs);

  const bytes = docRows.reduce((sum, row) => sum + row.size, 0);
  if (bytes > 0) await decrementOrgFileBytes(tx, orgId, bytes);

  const deleted = await tx
    .delete(spaces)
    .where(scopedWhere(spaces, { orgId, extra: [eq(spaces.id, spaceId)] }))
    .returning({ id: spaces.id });
  if (deleted.length === 0) throw notFound("Space not found");
}

// ─── Personal spaces: the two administrative acts and the sweeper ───────
//
// A personal space is not an administrative object: owners and admins neither
// read nor write one (RBAC spec §3.6). What is left to them is a TRANSFER —
// convert it to an ordinary team space — and, once its owner has left the
// organization and the window has closed, its removal. Both are audited by
// their routes.

/** The three administrative acts a space id can be pointed at (RBAC spec §3.6). */
export type SpaceAdminAct = "delete" | "convert-to-team" | "sweep";

/**
 * 404, 409, or proceed — the ONE decision behind `DELETE /api/spaces/{id}`,
 * `convert-to-team` and `sweep-now`.
 *
 * All three take a space id from an owner or admin and all three had to answer
 * the same question, which is why it is one function: a 409 naming a LIVE
 * personal space that is not the caller's is an existence ORACLE. It confirms
 * that a given id is somebody's private workspace to a principal for whom, on
 * every other route, that space does not exist (§3.6). The rule, in order:
 *
 *   - a TEAM space: `delete` proceeds (that is the ordinary deletion), while
 *     the two personal-space acts are a 409 `space_not_personal`. A team space
 *     is visible to every owner and admin, so naming it discloses nothing.
 *   - a personal space the caller OWNS: a 409, with the act's own code. They
 *     can see the space, so the reason is not a disclosure — and refusing by
 *     name is what tells them the space goes away through offboarding.
 *   - a personal space that is ORPHANED, to an owner or admin: proceed. Such a
 *     space is already listed to them (`isSpaceVisibleTo`) precisely so they
 *     can convert or sweep it, so there is nothing left to withhold. `delete`
 *     is still refused: `sweep-now` is the route that empties it first.
 *   - anything else — a live personal space that is not the caller's: **404**.
 *
 * `delete` therefore never returns "proceed" for a personal space at all; the
 * sweeper reaches {@link deleteSpace} directly with `actor: "sweeper"`.
 *
 * `caller.userId` is the principal's PERSONAL-SPACE identity
 * (`callerPersonalOwnerId`), not simply the authenticated user: `null` for an
 * API key or a role preview, which own no personal space. Reading the key
 * creator's id here made a key answer a named 409 on a space it 404s on
 * everywhere else — the oracle this function exists to close.
 */
export function assertSpaceAdminAct(
  space: { id: string; ownerUserId: string | null; orphanedAt: Date | null },
  caller: { userId: string | null; orgRole: OrgRole },
  act: SpaceAdminAct,
): void {
  if (space.ownerUserId === null) {
    if (act === "delete") return;
    throw conflict(
      "space_not_personal",
      act === "convert-to-team"
        ? "This space is already a team space."
        : "Only a personal space is swept; this is a team space.",
    );
  }

  const isOwner = caller.userId !== null && space.ownerUserId === caller.userId;
  const administersOrg = caller.orgRole === "owner" || caller.orgRole === "admin";
  if (!isOwner && !(space.orphanedAt !== null && administersOrg)) {
    throw notFound(`Space '${space.id}' not found in this organization`);
  }

  if (act === "delete") throw personalSpaceNotDeletable();
  if (space.orphanedAt === null) {
    // Its owner is still a member of the organization, so this is their live
    // private workspace. Only reachable for the owner themselves — anybody
    // else got the 404 above.
    throw conflict(
      "personal_space_not_orphaned",
      "This personal space still has an owner in the organization.",
    );
  }
}

/**
 * The caller's own personal space, provisioned if missing — the lazy repair
 * `GET /api/spaces` performs (plan decision 4). Its own transaction, because
 * there is nothing else to commit with it; the membership doors call
 * `ensurePersonalSpace` inside theirs instead.
 */
export async function ensureOwnPersonalSpace(orgId: string, userId: string): Promise<SpaceRow> {
  return ensurePersonalSpace(db, orgId, userId);
}

/**
 * Stamp the offboarding window on the personal space(s) `userId` owns in
 * `orgId`. Called inside `removeMember`'s transaction, so leaving the
 * organization and starting the clock commit together.
 *
 * @returns the space ids stamped — the audit trail of the removal.
 */
export async function orphanPersonalSpaces(
  tx: DbOrTx,
  orgId: string,
  userId: string,
): Promise<string[]> {
  const stamped = await tx
    .update(spaces)
    .set({ orphanedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(spaces.orgId, orgId),
        eq(spaces.ownerUserId, userId),
        // Already stamped means an earlier removal started the clock and a
        // re-join never cleared it; restarting it would extend the window.
        isNull(spaces.orphanedAt),
      ),
    )
    .returning({ id: spaces.id });
  return stamped.map((row) => row.id);
}

/**
 * Turn an ORPHANED personal space into an ordinary team space: `owner_user_id`
 * and `orphaned_at` go, `visibility` stays `private` (nothing about the
 * contents became less private), and no `space_members` row is written — the
 * former owner has left the organization, and only an orphaned space can be
 * converted, so there is never a standing to preserve.
 *
 * Only orphaned. This is the transfer that keeps what a DEPARTING member built
 * — the whole point of the 30-day window — and it is the ONLY way an
 * administrator reaches what is inside a personal space, which is why the route
 * audits it. Accepting a LIVE one would make it an administrative takeover of an
 * active member's private workspace, which §3.6 exists to refuse.
 *
 * The 404-vs-409 decision belongs to {@link assertSpaceAdminAct}, which the
 * route applies first; the refusals here are the in-transaction backstop, taken
 * under the row lock.
 *
 * @throws 404 when the space is not in `orgId`; 409 when it is a team space or
 *   still has an owner in the organization.
 */
export async function convertPersonalSpaceToTeam(
  orgId: string,
  spaceId: string,
): Promise<SpaceRow> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: spaces.id,
        ownerUserId: spaces.ownerUserId,
        orphanedAt: spaces.orphanedAt,
      })
      .from(spaces)
      .where(scopedWhere(spaces, { orgId, extra: [eq(spaces.id, spaceId)] }))
      .limit(1)
      .for("update");
    if (!current) throw notFound("Space not found");
    if (current.ownerUserId === null) {
      throw conflict("space_not_personal", "This space is already a team space.");
    }
    if (current.orphanedAt === null) {
      throw conflict(
        "personal_space_not_orphaned",
        "This personal space still has an owner in the organization.",
      );
    }

    const [space] = await tx
      .update(spaces)
      .set({ ownerUserId: null, orphanedAt: null, updatedAt: new Date() })
      .where(eq(spaces.id, spaceId))
      .returning();
    return space!;
  });
}

/** How long an orphaned personal space is kept before the sweeper empties it. */
export const PERSONAL_SPACE_GRACE_DAYS = 30;

/** Orphaned personal spaces whose window has closed. */
export async function listSweepablePersonalSpaces(now = new Date()) {
  const cutoff = new Date(now.getTime() - PERSONAL_SPACE_GRACE_DAYS * 86_400_000);
  return db
    .select({ id: spaces.id, orgId: spaces.orgId, ownerUserId: spaces.ownerUserId })
    .from(spaces)
    .where(and(isNotNull(spaces.ownerUserId), lt(spaces.orphanedAt, cutoff)))
    .orderBy(asc(spaces.orphanedAt));
}

/**
 * Empty a personal space of the packages it HOMES and then delete it.
 *
 * A homed package's write authority is this space (§6.9), so it cannot follow
 * the space out and `deleteSpace` refuses while one exists. The rule:
 *
 *   - installed in ANOTHER space → `home_space_id = NULL`, the organization
 *     catalogue. Somebody else is running it, so it is already not private, and
 *     owners/admins are the right authority for an author who has left.
 *   - installed nowhere else → deleted, with its published artifacts enqueued
 *     for physical removal. It was private to a person who is gone.
 *
 * ONE transaction, and every refusal comes BEFORE the first package mutation.
 * Both properties are load-bearing:
 *
 *   - `deleteSpace` can still refuse (a run went in flight, the space stopped
 *     being sweepable). Emptying the packages in a transaction of its own meant
 *     that refusal left the drafts deleted and the space standing — the loss the
 *     30-day window exists to prevent.
 *   - the listing that selected this space (`listSweepablePersonalSpaces`, or an
 *     administrator's `sweep-now`) is a separate read, so a `convert-to-team`
 *     can commit in between. The row is therefore re-read `FOR UPDATE` and the
 *     two facts re-asserted under the lock: without it the sweep would empty and
 *     delete a TEAM space, which is precisely what converting one was meant to
 *     save.
 *
 * The lock order is the org row then the space row, the same order
 * {@link deleteSpace} uses; re-taking either inside it is free.
 *
 * @throws 404 when the space is not in `orgId`; 409 `space_not_personal`,
 *   `personal_space_not_orphaned` or `space_has_active_runs` — the sweeper logs
 *   the refusal and retries on the next pass.
 */
export async function emptyAndDeletePersonalSpace(
  orgId: string,
  spaceId: string,
): Promise<{ rehomedPackages: number; deletedPackages: number }> {
  return db.transaction(async (tx) => {
    const [org] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
      .for("update");
    if (!org) throw notFound("Space not found");

    const [current] = await tx
      .select({ ownerUserId: spaces.ownerUserId, orphanedAt: spaces.orphanedAt })
      .from(spaces)
      .where(scopedWhere(spaces, { orgId, extra: [eq(spaces.id, spaceId)] }))
      .limit(1)
      .for("update");
    if (!current) throw notFound("Space not found");
    if (current.ownerUserId === null) {
      throw conflict("space_not_personal", "Only a personal space is swept; this is a team space.");
    }
    if (current.orphanedAt === null) {
      throw conflict(
        "personal_space_not_orphaned",
        "This personal space still has an owner in the organization.",
      );
    }

    // Before ANY package mutation, and the same predicate `deleteSpace` ends on:
    // reaching its refusal with the drafts already deleted is the failure this
    // ordering exists to rule out.
    if ((await countInProgressRuns(tx, { orgId, spaceId })) > 0) {
      throw spaceHasActiveRuns();
    }

    // The SAME predicate `deleteSpace` refuses on, deliberately: anything it
    // would count has to be dealt with here, ephemeral rows included.
    const homed = await tx
      .select({ id: packages.id })
      .from(packages)
      .where(and(eq(packages.orgId, orgId), eq(packages.homeSpaceId, spaceId)))
      .orderBy(asc(packages.id));

    let rehomedPackages = 0;
    let deletedPackages = 0;
    for (const pkg of homed) {
      const [elsewhere] = await tx
        .select({ spaceId: spacePackages.spaceId })
        .from(spacePackages)
        .where(and(eq(spacePackages.packageId, pkg.id), ne(spacePackages.spaceId, spaceId)))
        .limit(1);
      if (elsewhere) {
        await tx
          .update(packages)
          .set({ homeSpaceId: null, updatedAt: new Date() })
          .where(eq(packages.id, pkg.id));
        rehomedPackages++;
        continue;
      }
      // Enumerate the artifacts BEFORE the row goes: `package_versions`
      // cascades and their storage keys become unrecoverable (same reason
      // `deleteOrgItem` does it in this order).
      const jobs = await packageStorageDeletionJobs(tx, orgId, pkg.id, "personal_space_swept");
      const deleted = await tx
        .delete(packages)
        .where(and(eq(packages.id, pkg.id), eq(packages.orgId, orgId)))
        .returning({ id: packages.id });
      if (deleted.length > 0) {
        await enqueueStorageDeletion(tx, jobs);
        deletedPackages++;
      }
    }

    // Inside the same transaction, so the space and the packages it homed
    // commit or roll back together.
    await deleteSpace(orgId, spaceId, "sweeper", tx);
    return { rehomedPackages, deletedPackages };
  });
}
