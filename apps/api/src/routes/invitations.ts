import { Hono } from "hono";
import { db } from "@appstrate/db/client";
import { user } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@appstrate/db/auth";
import { logger } from "../lib/logger.ts";
import { ApiError, invalidRequest, internalError, gone } from "../lib/errors.ts";
import {
  getInvitationByToken,
  markInvitationAccepted,
  getInviterName,
  getOrgName,
} from "../services/invitations.ts";
import { addMember } from "../services/organizations.ts";

const router = new Hono();

function assertInvitationExists(
  invitation: Awaited<ReturnType<typeof getInvitationByToken>>,
): asserts invitation is NonNullable<typeof invitation> {
  if (!invitation) {
    throw new ApiError({
      status: 404,
      code: "invitation_not_found",
      title: "Not Found",
      detail: "Invitation not found",
    });
  }
}

function assertInvitationUsable(invitation: { status: string; expiresAt: Date }): void {
  if (invitation.status === "accepted") {
    throw gone("invitation_accepted", "Invitation already accepted");
  }
  if (invitation.status === "cancelled") {
    throw gone("invitation_cancelled", "Invitation cancelled");
  }
  if (invitation.status === "expired" || invitation.expiresAt < new Date()) {
    throw gone("invitation_expired", "Invitation expired");
  }
}

// GET /invite/:token/info — public metadata for invitation
router.get("/:token/info", async (c) => {
  const token = c.req.param("token");
  const invitation = await getInvitationByToken(token);
  assertInvitationExists(invitation);
  assertInvitationUsable(invitation);

  const [orgName, inviterName, [existingUser]] = await Promise.all([
    getOrgName(invitation.orgId),
    invitation.invitedBy ? getInviterName(invitation.invitedBy) : Promise.resolve("A member"),
    db.select({ id: user.id }).from(user).where(eq(user.email, invitation.email)).limit(1),
  ]);

  return c.json({
    email: invitation.email,
    orgName,
    role: invitation.role,
    inviterName,
    expiresAt: invitation.expiresAt.toISOString(),
    isNewUser: !existingUser,
  });
});

// POST /invite/:token/accept — accept invitation (public)
router.post("/:token/accept", async (c) => {
  const token = c.req.param("token");
  const invitation = await getInvitationByToken(token);
  assertInvitationExists(invitation);
  assertInvitationUsable(invitation);

  // Check if user already exists
  const [existingUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, invitation.email))
    .limit(1);

  if (!existingUser) {
    // --- NEW USER: create account via Better Auth ---
    const body = await c.req
      .json<{ password?: string; displayName?: string }>()
      .catch((): { password?: string; displayName?: string } => ({}));

    if (!body.password || body.password.length < 8) {
      throw invalidRequest("Password is required and must be at least 8 characters");
    }

    try {
      // Sign up — creates user + account + profile (via databaseHook)
      const signupRes = await auth.api.signUpEmail({
        body: {
          email: invitation.email,
          password: body.password,
          name: body.displayName?.trim() || invitation.email,
        },
      });

      if (!signupRes?.user?.id) {
        logger.error("Invitation signup failed — no user returned", {
          email: invitation.email,
        });
        throw internalError();
      }

      const newUserId = signupRes.user.id;

      // Sign in to get session cookie
      const signinRes = await auth.api.signInEmail({
        body: { email: invitation.email, password: body.password },
        asResponse: true,
      });

      // Add member to org
      await addMember(invitation.orgId, newUserId, invitation.role as "member" | "admin");

      await markInvitationAccepted(invitation.id, newUserId);

      // Forward Set-Cookie from signin response
      const setCookieHeader = signinRes.headers.get("set-cookie");
      const headers = new Headers();
      headers.set("Content-Type", "application/json");
      if (setCookieHeader) {
        headers.set("Set-Cookie", setCookieHeader);
      }

      return new Response(
        JSON.stringify({
          success: true,
          isNewUser: true,
          orgId: invitation.orgId,
        }),
        { status: 200, headers },
      );
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Invitation accept failed (new user)", {
        error: err instanceof Error ? err.message : String(err),
        email: invitation.email,
      });
      throw internalError();
    }
  } else {
    // --- EXISTING USER ---
    const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);

    // Prevent a logged-in user from accepting an invitation meant for a different email
    if (session?.user && session.user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new ApiError({
        status: 403,
        code: "email_mismatch",
        title: "Email mismatch",
        detail: `This invitation is for ${invitation.email}`,
      });
    }

    await addMember(invitation.orgId, existingUser.id, invitation.role as "member" | "admin");

    await markInvitationAccepted(invitation.id, existingUser.id);

    return c.json({
      success: true,
      isNewUser: false,
      orgId: invitation.orgId,
      requiresLogin: !session?.user,
    });
  }
});

export default router;
