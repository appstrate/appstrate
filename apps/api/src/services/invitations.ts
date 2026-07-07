// SPDX-License-Identifier: Apache-2.0

import { db } from "@appstrate/db/client";
import { orgInvitations, organizations, user, profiles, orgRoleEnum } from "@appstrate/db/schema";
import { eq, and, lt, gt, desc } from "drizzle-orm";
import { getEnv } from "@appstrate/env";
import { getAppConfig } from "../lib/app-config.ts";
import { sendEmail } from "./email.ts";
import { scopedWhere } from "../lib/db-helpers.ts";

/** Accepts either the base client or an open transaction handle. */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Roles assignable via invitation (excludes owner — transferred, not invited). */
export const ASSIGNABLE_ROLES = ["viewer", "member", "admin"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

// Compile-time exhaustiveness check: if `orgRoleEnum` gains a new value, this
// line fails to type-check until it is added to `ASSIGNABLE_ROLES` above (or
// explicitly excluded like `owner`).
type _MissingAssignableRoles = Exclude<
  Exclude<(typeof orgRoleEnum.enumValues)[number], "owner">,
  AssignableRole
>;
const _assertAssignableRolesExhaustive: _MissingAssignableRoles extends never ? true : never = true;
void _assertAssignableRolesExhaustive;

function generateToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

export async function createInvitation({
  email,
  orgId,
  role,
  invitedBy,
}: {
  email: string;
  orgId: string;
  role: AssignableRole;
  invitedBy: string;
}) {
  const normalizedEmail = email.toLowerCase().trim();

  // Cancel any existing pending invitations for this org+email
  await db
    .update(orgInvitations)
    .set({ status: "cancelled" })
    .where(
      scopedWhere(orgInvitations, {
        orgId,
        extra: [eq(orgInvitations.email, normalizedEmail), eq(orgInvitations.status, "pending")],
      }),
    );

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const [invitation] = await db
    .insert(orgInvitations)
    .values({
      token,
      email: normalizedEmail,
      orgId,
      role,
      invitedBy,
      expiresAt,
    })
    .returning();

  if (!invitation) throw new Error("Failed to create invitation");

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
 * `true` if THIS call won the claim, `false` if the row was already consumed
 * (lost a concurrent race) or has passed `expiresAt`. The `WHERE status =
 * 'pending'` guard is what makes two simultaneous accepts safe — the row lock
 * lets exactly one UPDATE match. The `expiresAt > now()` guard closes the gap
 * between real expiry and the periodic `expireOldInvitations()` sweep that
 * flips the status to `expired`: without it an expired-but-not-yet-swept
 * invitation was still acceptable.
 */
export async function markInvitationAccepted(
  invitationId: string,
  userId: string,
  tx: DbOrTx = db,
): Promise<boolean> {
  const claimed = await tx
    .update(orgInvitations)
    .set({ status: "accepted", acceptedBy: userId, acceptedAt: new Date() })
    .where(
      and(
        eq(orgInvitations.id, invitationId),
        eq(orgInvitations.status, "pending"),
        gt(orgInvitations.expiresAt, new Date()),
      ),
    )
    .returning({ id: orgInvitations.id });
  return claimed.length > 0;
}

export async function cancelInvitation(invitationId: string, orgId: string) {
  const [cancelled] = await db
    .update(orgInvitations)
    .set({ status: "cancelled" })
    .where(scopedWhere(orgInvitations, { orgId, extra: [eq(orgInvitations.id, invitationId)] }))
    .returning({ id: orgInvitations.id });
  return cancelled ?? null;
}

export async function updateInvitationRole(
  invitationId: string,
  orgId: string,
  role: AssignableRole,
) {
  const [updated] = await db
    .update(orgInvitations)
    .set({ role })
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
