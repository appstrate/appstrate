import { db } from "../lib/db.ts";
import { orgInvitations, organizations, user, profiles } from "@appstrate/db/schema";
import { eq, and, lt } from "drizzle-orm";

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
  role: "member" | "admin";
  invitedBy: string;
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
    .orderBy(orgInvitations.createdAt);
}

export async function markInvitationAccepted(invitationId: string, userId: string) {
  await db
    .update(orgInvitations)
    .set({ status: "accepted", acceptedBy: userId, acceptedAt: new Date() })
    .where(eq(orgInvitations.id, invitationId));
}

export async function cancelInvitation(invitationId: string) {
  await db
    .update(orgInvitations)
    .set({ status: "cancelled" })
    .where(eq(orgInvitations.id, invitationId));
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
