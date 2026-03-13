import { Hono } from "hono";
import { db } from "../lib/db.ts";
import { user } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { auth } from "../lib/auth.ts";
import { logger } from "../lib/logger.ts";
import {
  getInvitationByToken,
  markInvitationAccepted,
  getInviterName,
  getOrgName,
} from "../services/invitations.ts";
import { addMember } from "../services/organizations.ts";

const router = new Hono();

// GET /invite/:token/info — public metadata for invitation
router.get("/:token/info", async (c) => {
  const token = c.req.param("token");
  const invitation = await getInvitationByToken(token);

  if (!invitation) {
    return c.json({ error: "INVITATION_NOT_FOUND", message: "Invitation not found" }, 404);
  }

  if (invitation.status === "accepted") {
    return c.json({ error: "INVITATION_ACCEPTED", message: "Invitation already accepted" }, 410);
  }
  if (invitation.status === "cancelled") {
    return c.json({ error: "INVITATION_CANCELLED", message: "Invitation cancelled" }, 410);
  }
  if (invitation.status === "expired" || invitation.expiresAt < new Date()) {
    return c.json({ error: "INVITATION_EXPIRED", message: "Invitation expired" }, 410);
  }

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

  if (!invitation) {
    return c.json({ error: "INVITATION_NOT_FOUND", message: "Invitation not found" }, 404);
  }

  if (invitation.status === "accepted") {
    return c.json({ error: "INVITATION_ACCEPTED", message: "Invitation already accepted" }, 410);
  }
  if (invitation.status === "cancelled") {
    return c.json({ error: "INVITATION_CANCELLED", message: "Invitation cancelled" }, 410);
  }
  if (invitation.status === "expired" || invitation.expiresAt < new Date()) {
    return c.json({ error: "INVITATION_EXPIRED", message: "Invitation expired" }, 410);
  }

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
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "Password is required and must be at least 8 characters",
        },
        400,
      );
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
        return c.json({ error: "SIGNUP_FAILED", message: "Failed to create account" }, 500);
      }

      const newUserId = signupRes.user.id;

      // Sign in to get session cookie
      const signinRes = await auth.api.signInEmail({
        body: { email: invitation.email, password: body.password },
        asResponse: true,
      });

      // Add member to org
      try {
        await addMember(invitation.orgId, newUserId, invitation.role as "member" | "admin");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("duplicate key") && !msg.includes("unique constraint")) {
          throw err;
        }
        // Already a member — skip
      }

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
      logger.error("Invitation accept failed (new user)", {
        error: err instanceof Error ? err.message : String(err),
        email: invitation.email,
      });
      return c.json({ error: "ACCEPT_FAILED", message: "Failed to accept invitation" }, 500);
    }
  } else {
    // --- EXISTING USER ---
    try {
      await addMember(invitation.orgId, existingUser.id, invitation.role as "member" | "admin");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("duplicate key") && !msg.includes("unique constraint")) {
        throw err;
      }
      // Already a member — skip
    }

    await markInvitationAccepted(invitation.id, existingUser.id);

    // Check if request already has a session
    const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);

    return c.json({
      success: true,
      isNewUser: false,
      orgId: invitation.orgId,
      requiresLogin: !session?.user,
    });
  }
});

export default router;
