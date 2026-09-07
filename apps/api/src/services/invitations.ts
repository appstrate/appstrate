// SPDX-License-Identifier: Apache-2.0

import { db } from "@appstrate/db/client";
import { orgInvitations, organizations, user, profiles } from "@appstrate/db/schema";
import type { SpaceAssignment } from "@appstrate/core/permissions";
import type { AssignableOrgRole } from "@appstrate/shared-types";
import { eq, and, lt, lte, gt, desc } from "drizzle-orm";
import { getEnv } from "@appstrate/env";
import { getAppConfig } from "../lib/app-config.ts";
import { sendEmail } from "./email.ts";
import { isUniqueViolation, scopedWhere } from "../lib/db-helpers.ts";

/** Accepts either the base client or an open transaction handle. */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

function generateToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

/**
 * The (org, email) pair already has a valid pending invitation. Thrown by
 * {@link createInvitation}; the route maps it to 409 `invitation_already_pending`
 * and the UI sends the administrator to the existing invitation's editor —
 * extending it is how a second space is added, never a second token.
 */
export class InvitationAlreadyPendingError extends Error {
  constructor(readonly invitationId: string) {
    super("A pending invitation already exists for this email");
    this.name = "InvitationAlreadyPendingError";
  }
}

/**
 * One row is the whole lifecycle of a person's invitation into an org. A second
 * create for the same address therefore REFUSES rather than replacing: the old
 * behaviour (cancel every pending row, insert a fresh one) silently dropped the
 * first space assignment and invalidated a link already shared. Only an
 * expired-but-unswept pending row is cancelled here, so a fresh invitation can
 * follow an expired one without waiting for `expireOldInvitations()`.
 *
 * Two creates racing past the pre-check both reach the INSERT; the partial
 * unique index `uq_org_invitations_pending` (0057) lets exactly one through and
 * the loser's 23505 is mapped to the same error, so callers see one contract.
 */
export async function createInvitation({
  email,
  orgId,
  role,
  invitedBy,
  spaceAssignments,
}: {
  email: string;
  orgId: string;
  role: AssignableOrgRole;
  invitedBy: string;
  spaceAssignments: ReadonlyArray<SpaceAssignment>;
}) {
  const normalizedEmail = email.toLowerCase().trim();
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const pendingForPair = scopedWhere(orgInvitations, {
    orgId,
    extra: [eq(orgInvitations.email, normalizedEmail), eq(orgInvitations.status, "pending")],
  });

  const invitation = await db
    .transaction(async (tx) => {
      const now = new Date();
      // Expired but not yet swept: a dead link, cancelled so the pair is free.
      await tx
        .update(orgInvitations)
        .set({ status: "cancelled" })
        .where(and(pendingForPair, lte(orgInvitations.expiresAt, now)));
      const [existing] = await tx
        .select({ id: orgInvitations.id })
        .from(orgInvitations)
        .where(and(pendingForPair, gt(orgInvitations.expiresAt, now)))
        .limit(1);
      if (existing) throw new InvitationAlreadyPendingError(existing.id);

      const [created] = await tx
        .insert(orgInvitations)
        .values({
          token,
          email: normalizedEmail,
          orgId,
          role,
          invitedBy,
          spaceAssignments,
          expiresAt,
        })
        .returning();
      if (!created) throw new Error("Failed to create invitation");
      return created;
    })
    .catch(async (err: unknown) => {
      if (!isUniqueViolation(err)) throw err;
      // Lost the race against a concurrent create for the same pair: report the
      // row that won, exactly as the pre-check would have. Without a winner
      // (the rival was cancelled between the INSERT and this read) the 409's
      // required `invitation_id` would be empty, so the constraint violation
      // itself is what surfaces.
      const [winner] = await db
        .select({ id: orgInvitations.id })
        .from(orgInvitations)
        .where(pendingForPair)
        .limit(1);
      if (!winner) throw err;
      throw new InvitationAlreadyPendingError(winner.id);
    });

  if (getAppConfig().features.smtp) {
    const [orgName, inviterName] = await Promise.all([
      getOrgName(orgId),
      getInviterName(invitedBy),
    ]);
    const inviteUrl = `${getEnv().APP_URL}/invite/${token}`;
    void sendEmail("invitation", {
      to: normalizedEmail,
      email: normalizedEmail,
      inviteUrl,
      orgName,
      inviterName,
      role,
      locale: "fr",
    });
  }

  return invitation;
}

export async function getInvitationByToken(token: string) {
  const [row] = await db
    .select()
    .from(orgInvitations)
    .where(eq(orgInvitations.token, token))
    .limit(1);

  return row ?? null;
}

/** One pending invitation of `orgId`, or null. */
export async function getPendingInvitation(invitationId: string, orgId: string) {
  const [row] = await db
    .select()
    .from(orgInvitations)
    .where(
      scopedWhere(orgInvitations, {
        orgId,
        extra: [eq(orgInvitations.id, invitationId), eq(orgInvitations.status, "pending")],
      }),
    )
    .limit(1);
  return row ?? null;
}

export async function getOrgInvitations(orgId: string) {
  return db
    .select()
    .from(orgInvitations)
    .where(scopedWhere(orgInvitations, { orgId, extra: [eq(orgInvitations.status, "pending")] }))
    .orderBy(desc(orgInvitations.createdAt));
}

/**
 * Atomically claim a single-use invitation: flips `pending → accepted` only if
 * it is still pending AND not yet expired, in one conditional UPDATE. Returns
 * the claimed row if THIS call won, null if the row was already consumed
 * (lost a concurrent race) or has passed `expiresAt`. The `WHERE status =
 * 'pending'` guard is what makes two simultaneous accepts safe — the row lock
 * lets exactly one UPDATE match. The `expiresAt > now()` guard closes the gap
 * between real expiry and the periodic `expireOldInvitations()` sweep that
 * flips the status to `expired`: without it an expired-but-not-yet-swept
 * invitation was still acceptable.
 *
 * `status` is the whole write. The row used to also record `accepted_by` /
 * `accepted_at`, which nothing ever read back — see the `orgInvitations` table
 * doc; both columns were dropped in `0055`. Who accepted and when is in the
 * audit log, which outlives the invitation row: the `org.invitation_accepted`
 * event written by `routes/invitations.ts` right after this call wins its
 * claim, whose `actor_id` is the who and whose `created_at` is the when.
 * That write did not exist when the columns were dropped, so the substitute
 * was a claim and not a fact for one release; `test/integration/routes/
 * invitations.test.ts` now asserts it.
 */
export async function markInvitationAccepted(invitationId: string, tx: DbOrTx = db) {
  const [claimed] = await tx
    .update(orgInvitations)
    .set({ status: "accepted" })
    .where(
      and(
        eq(orgInvitations.id, invitationId),
        eq(orgInvitations.status, "pending"),
        gt(orgInvitations.expiresAt, new Date()),
      ),
    )
    .returning();
  return claimed ?? null;
}

export async function cancelInvitation(invitationId: string, orgId: string) {
  const [cancelled] = await db
    .update(orgInvitations)
    .set({ status: "cancelled" })
    .where(scopedWhere(orgInvitations, { orgId, extra: [eq(orgInvitations.id, invitationId)] }))
    .returning({ id: orgInvitations.id });
  return cancelled ?? null;
}

export async function updateInvitation(
  invitationId: string,
  orgId: string,
  values: { role: AssignableOrgRole; spaceAssignments: ReadonlyArray<SpaceAssignment> },
) {
  const [updated] = await db
    .update(orgInvitations)
    .set(values)
    .where(
      scopedWhere(orgInvitations, {
        orgId,
        extra: [eq(orgInvitations.id, invitationId), eq(orgInvitations.status, "pending")],
      }),
    )
    .returning();

  return updated ?? null;
}

export async function getOrgName(orgId: string): Promise<string> {
  const [row] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return row?.name ?? "Organisation";
}

export async function getInviterName(userId: string): Promise<string> {
  const [row] = await db
    .select({ displayName: profiles.displayName, name: user.name })
    .from(user)
    .leftJoin(profiles, eq(profiles.id, user.id))
    .where(eq(user.id, userId))
    .limit(1);
  return row?.displayName || row?.name || "Un membre";
}

export async function expireOldInvitations() {
  const result = await db
    .update(orgInvitations)
    .set({ status: "expired" })
    .where(and(eq(orgInvitations.status, "pending"), lt(orgInvitations.expiresAt, new Date())))
    .returning({ id: orgInvitations.id });

  return result.length;
}
