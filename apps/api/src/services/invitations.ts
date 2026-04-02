// SPDX-License-Identifier: Apache-2.0

import { db } from "@appstrate/db/client";
import { orgInvitations, organizations, user, profiles } from "@appstrate/db/schema";
import { eq, and, lt, desc } from "drizzle-orm";
import { getEnv } from "@appstrate/env";
import { getAppConfig } from "../lib/app-config.ts";
import { sendEmail } from "./email.ts";
import { auth } from "@appstrate/db/auth";
import { logger } from "../lib/logger.ts";

/** Roles assignable via invitation (excludes owner — transferred, not invited). */
export const ASSIGNABLE_ROLES = ["viewer", "member", "admin"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

function generateToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

export async function createInvitation({
  email,
  orgId,
  role,
  invitedBy,
  skipEmail,
}: {
  email: string;
  orgId: string;
  role: AssignableRole;
  invitedBy: string;
  skipEmail?: boolean;
}) {
  const normalizedEmail = email.toLowerCase().trim();

  // Cancel any existing pending invitations for this org+email
  await db
    .update(orgInvitations)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(orgInvitations.orgId, orgId),
        eq(orgInvitations.email, normalizedEmail),
        eq(orgInvitations.status, "pending"),
      ),
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

  if (!skipEmail && getAppConfig().features.smtp) {
    const [orgName, inviterName] = await Promise.all([
      getOrgName(orgId),
      getInviterName(invitedBy),
    ]);
    const inviteUrl = `${getEnv().APP_URL}/invite/${token}/accept`;
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
    .where(and(eq(orgInvitations.orgId, orgId), eq(orgInvitations.status, "pending")))
    .orderBy(desc(orgInvitations.createdAt));
}

export async function markInvitationAccepted(invitationId: string, userId: string) {
  await db
    .update(orgInvitations)
    .set({ status: "accepted", acceptedBy: userId, acceptedAt: new Date() })
    .where(eq(orgInvitations.id, invitationId));
}

export async function cancelInvitation(invitationId: string, orgId: string) {
  const [cancelled] = await db
    .update(orgInvitations)
    .set({ status: "cancelled" })
    .where(and(eq(orgInvitations.id, invitationId), eq(orgInvitations.orgId, orgId)))
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
      and(
        eq(orgInvitations.id, invitationId),
        eq(orgInvitations.orgId, orgId),
        eq(orgInvitations.status, "pending"),
      ),
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

/**
 * Trigger Better Auth magic link for an existing user invitation.
 * The callbackURL contains the invitation token — the sendMagicLink callback
 * in auth.ts detects this and sends the invitation email instead of the generic one.
 */
export async function sendMagicLinkInvitation(invitation: {
  id: string;
  token: string;
  email: string;
}) {
  try {
    await auth.api.signInMagicLink({
      body: {
        email: invitation.email,
        callbackURL: `/invite/${invitation.token}/accept`,
      },
      headers: new Headers(),
    });
  } catch (err) {
    logger.error("Failed to send magic link invitation", {
      error: err instanceof Error ? err.message : String(err),
      email: invitation.email,
      invitationId: invitation.id,
    });
  }
}

export async function expireOldInvitations() {
  const result = await db
    .update(orgInvitations)
    .set({ status: "expired" })
    .where(and(eq(orgInvitations.status, "pending"), lt(orgInvitations.expiresAt, new Date())))
    .returning({ id: orgInvitations.id });

  return result.length;
}
