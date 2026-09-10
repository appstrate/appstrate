// SPDX-License-Identifier: Apache-2.0

/**
 * What it takes for an organization, or a member of one, to be usable.
 *
 * An org needs its owner's membership, a default space for that owner to land
 * in, and the owner's own personal space; a member needs their membership row
 * and their personal space. Every one of those writes belongs in the SAME
 * transaction as the row it depends on — the default space used to be created
 * after the commit, outside it, with a swallowed `.catch`, in two places.
 *
 * It lives in `packages/db` rather than in `apps/api/src/services` because
 * `bootstrap-org.ts` (right next door) provisions the root organization before
 * any API service exists, and cannot import from `apps/api`. Keeping ONE
 * implementation here is what makes "no membership door skips the personal
 * space" checkable: the doors call this, not their own INSERT.
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md §3.6
 */

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { db } from "./client.ts";
import { prefixedId } from "./ids.ts";
import { organizations, organizationMembers } from "./schema/organizations.ts";
import { spaces } from "./schema/spaces.ts";

/** Accepts either the base client or an open transaction handle. */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

type SpaceRow = InferSelectModel<typeof spaces>;

/**
 * The stored name of a personal space. A DATUM, not a label: the SPA renders
 * its own translation off `personal: true` on the wire and never shows this,
 * which is why nothing outside this module needs the constant.
 */
const PERSONAL_SPACE_NAME = "Mon espace";

/** The name every organization's landing space is created with. */
export const DEFAULT_SPACE_NAME = "Default";

/**
 * `userId`'s personal space in `orgId`, created if it does not exist yet.
 *
 * READ BEFORE WRITE, deliberately — the `createDefaultSpace` shape. This runs
 * on every `GET /api/spaces` (the lazy repair of plan decision 4), where the
 * overwhelmingly common case is a space that already exists; an unconditional
 * upsert made a listing a WRITE, taking a row lock and burning an xid on every
 * dashboard poll. The fast path is one indexed lookup on `uq_spaces_org_owner`
 * and no write at all.
 *
 * The upsert stays as the path that actually provisions, and it is what makes
 * the operation race-safe: the partial unique index is its conflict target, so
 * two concurrent provisions cannot both insert. Its `DO UPDATE` half is the
 * RE-JOIN — a member who left inside the sweeper's 30-day window and came back
 * gets their space back, drafts and all — which is also why the fast path
 * requires `orphaned_at IS NULL`: an orphaned row must fall through to the
 * clause that revives it, not be handed back still stamped.
 *
 * `tx` is a required parameter, not a default: a membership row and this space
 * commit together, so a half-provisioned member cannot exist.
 */
export async function ensurePersonalSpace(
  tx: DbOrTx,
  orgId: string,
  userId: string,
): Promise<SpaceRow> {
  const [live] = await tx
    .select()
    .from(spaces)
    .where(and(eq(spaces.orgId, orgId), eq(spaces.ownerUserId, userId), isNull(spaces.orphanedAt)))
    .limit(1);
  if (live) return live;

  const [upserted] = await tx
    .insert(spaces)
    .values({
      id: prefixedId("spc"),
      orgId,
      name: PERSONAL_SPACE_NAME,
      isDefault: false,
      visibility: "private",
      ownerUserId: userId,
      createdBy: userId,
    })
    .onConflictDoUpdate({
      target: [spaces.orgId, spaces.ownerUserId],
      targetWhere: isNotNull(spaces.ownerUserId),
      set: { orphanedAt: null, updatedAt: new Date() },
      setWhere: isNotNull(spaces.orphanedAt),
    })
    .returning();
  if (upserted) return upserted;

  // The insert conflicted and the `DO UPDATE` matched nothing, i.e. a LIVE row
  // for this pair appeared between the select above and the upsert — a
  // concurrent provision won the race. Re-read it.
  const [existing] = await tx
    .select()
    .from(spaces)
    .where(and(eq(spaces.orgId, orgId), eq(spaces.ownerUserId, userId)))
    .limit(1);
  if (!existing) {
    // Not finding it now means it was deleted between the two statements —
    // loud rather than silent.
    throw new Error(`ensurePersonalSpace: space for (${orgId}, ${userId}) vanished mid-provision`);
  }
  return existing;
}

/**
 * Create an organization with everything that makes it usable: the row, its
 * owner's membership, the default space, and the owner's personal space.
 *
 * `tx` is required for the same reason as above — the caller owns the
 * transaction, because it usually has its own preconditions to hold inside it
 * (a claimed slug, a locked invitation).
 */
export async function provisionOrg(
  tx: DbOrTx,
  params: {
    name: string;
    slug: string;
    ownerUserId: string;
    /** Written verbatim onto `organizations.org_settings`; omitted leaves the column default. */
    orgSettings?: Record<string, unknown>;
  },
): Promise<{
  org: InferSelectModel<typeof organizations>;
  defaultSpace: SpaceRow;
  personalSpace: SpaceRow;
}> {
  const [org] = await tx
    .insert(organizations)
    .values({
      name: params.name,
      slug: params.slug,
      createdBy: params.ownerUserId,
      ...(params.orgSettings ? { orgSettings: params.orgSettings } : {}),
    })
    .returning();
  if (!org) throw new Error("provisionOrg: organizations insert returned no row");

  await tx.insert(organizationMembers).values({
    orgId: org.id,
    userId: params.ownerUserId,
    role: "owner",
  });

  const [defaultSpace] = await tx
    .insert(spaces)
    .values({
      id: prefixedId("spc"),
      orgId: org.id,
      name: DEFAULT_SPACE_NAME,
      isDefault: true,
      createdBy: params.ownerUserId,
    })
    .returning();
  if (!defaultSpace) throw new Error("provisionOrg: default space insert returned no row");

  const personalSpace = await ensurePersonalSpace(tx, org.id, params.ownerUserId);
  return { org, defaultSpace, personalSpace };
}
