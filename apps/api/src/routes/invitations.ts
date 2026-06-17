// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { db } from "@appstrate/db/client";
import { user } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { getAuth } from "@appstrate/db/auth";
import { ApiError, gone } from "../lib/errors.ts";
import {
  getInvitationByToken,
  markInvitationAccepted,
  getInviterName,
  getOrgName,
  type AssignableRole,
} from "../services/invitations.ts";
import { addMember, getOrgById } from "../services/organizations.ts";

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
    org_name: orgName,
    role: invitation.role,
    inviter_name: inviterName,
    expiresAt: invitation.expiresAt.toISOString(),
    is_new_user: !existingUser,
  });
});

// POST /invite/:token/accept — authenticated user joins the org.
//
// Public route (registered before the platform auth middleware) but a valid
// Better Auth session is REQUIRED: the caller authenticates first through the
// platform-standard path (OIDC when the module is loaded, otherwise the
// built-in email/password + social forms), then accepts. Account creation
// never happens here — this endpoint has a single responsibility: bind an
// already-authenticated user to the org named by the invitation token.
//
// Accept is a deliberate, session-bound POST: it is never a GET (no
// state-change on link prefetch) and never auto-fires, so an email-client
// prefetch or a logged-in stranger cannot silently join the org.
router.post("/:token/accept", async (c) => {
  const token = c.req.param("token");
  const invitation = await getInvitationByToken(token);
  assertInvitationExists(invitation);
  assertInvitationUsable(invitation);

  const session = await getAuth()
    .api.getSession({ headers: c.req.raw.headers })
    .catch(() => null);

  if (!session?.user) {
    throw new ApiError({
      status: 401,
      code: "authentication_required",
      title: "Unauthorized",
      detail: "Authentication is required to accept an invitation",
    });
  }

  // The invitation is bound to a single email; the session must own it.
  // This is also the security backstop for the email pinned client-side on
  // the login/signup forms — a tampered email field cannot escape it.
  if (session.user.email.toLowerCase() !== invitation.email.toLowerCase()) {
    throw new ApiError({
      status: 403,
      code: "email_mismatch",
      title: "Email mismatch",
      detail: `This invitation is for ${invitation.email}`,
    });
  }

  const org = await getOrgById(invitation.orgId);
  if (!org) {
    throw new ApiError({
      status: 404,
      code: "org_not_found",
      title: "Not Found",
      detail: "Organization not found",
    });
  }

  await addMember(invitation.orgId, session.user.id, invitation.role as AssignableRole);
  await markInvitationAccepted(invitation.id, session.user.id);

  // Bare joined-org resource — same shape as the items in GET /api/orgs
  // (issue #657). The web accept page reads `id` to pin the org store.
  return c.json({
    id: org.id,
    name: org.name,
    slug: org.slug,
    role: invitation.role,
    createdAt: org.createdAt,
  });
});

export default router;
