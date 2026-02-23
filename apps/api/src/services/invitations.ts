import { db } from "../lib/db.ts";
import { orgInvitations, organizations, profiles } from "@appstrate/db/schema";
import { eq, and, lt } from "drizzle-orm";
import { logger } from "../lib/logger.ts";
import { sendEmail } from "./email.ts";
import { getEnv } from "@appstrate/env";

const BASE_URL = getEnv().APP_URL;

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

export async function expireOldInvitations() {
  const result = await db
    .update(orgInvitations)
    .set({ status: "expired" })
    .where(and(eq(orgInvitations.status, "pending"), lt(orgInvitations.expiresAt, new Date())))
    .returning({ id: orgInvitations.id });

  return result.length;
}

export async function sendInvitationEmail({
  email,
  token,
  orgName,
  inviterName,
}: {
  email: string;
  token: string;
  orgName: string;
  inviterName: string;
}) {
  const inviteUrl = `${BASE_URL}/invite/${token}`;

  const htmlContent = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:480px;margin:40px auto;padding:32px;background:#141414;border-radius:12px;border:1px solid #2a2a2a;">
    <h2 style="margin:0 0 8px;color:#fff;font-size:20px;">Appstrate</h2>
    <p style="margin:0 0 24px;color:#888;font-size:14px;">Invitation à rejoindre une organisation</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">
      <strong style="color:#fff;">${inviterName}</strong> vous invite à rejoindre l'organisation <strong style="color:#fff;">${orgName}</strong> sur Appstrate.
    </p>
    <a href="${inviteUrl}" style="display:inline-block;padding:12px 24px;background:#4f8eff;color:#fff;text-decoration:none;border-radius:8px;font-weight:500;font-size:15px;margin:16px 0 24px;">
      Accepter l'invitation
    </a>
    <p style="margin:0 0 8px;color:#666;font-size:13px;">
      Ou copiez ce lien : <a href="${inviteUrl}" style="color:#4f8eff;word-break:break-all;">${inviteUrl}</a>
    </p>
    <p style="margin:16px 0 0;color:#555;font-size:12px;">
      Cette invitation expire dans 7 jours. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.
    </p>
  </div>
</body>
</html>`;

  sendEmail({
    to: email,
    subject: `${inviterName} vous invite à rejoindre ${orgName} sur Appstrate`,
    htmlContent,
  }).catch((err) => {
    logger.error("Failed to send invitation email", {
      error: err instanceof Error ? err.message : String(err),
      email,
    });
  });
}

export async function getInviterName(userId: string): Promise<string> {
  const [row] = await db
    .select({ displayName: profiles.displayName })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  return row?.displayName || "Un membre";
}

export async function getOrgName(orgId: string): Promise<string> {
  const [row] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return row?.name || "Organisation";
}
