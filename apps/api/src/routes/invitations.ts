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
} from "../services/invitations.ts";
import { addMember, getOrgById } from "../services/organizations.ts";
import { applyInvitationSpaceAssignments } from "../services/space-members.ts";
import { recordAudit } from "../services/audit.ts";
import { getClientIpFromRequest } from "../lib/client-ip.ts";
import type { AssignableOrgRole } from "@appstrate/shared-types";
import { assertOrgRole, listedOrgPermissions } from "../lib/permissions.ts";

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
    space_assignments: invitation.spaceAssignments,
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

  // Claim the single-use token and add the membership in ONE transaction so
  // the two writes can never half-apply (user joined but invite still pending,
  // or vice versa). The claim is conditional on `status = 'pending'`, so two
  // concurrent accepts can't both succeed — the loser sees 0 rows claimed and
  // is reported as already-accepted. `addMember` is idempotent (it swallows the
  // unique violation), so an existing membership keeps the claim valid.
  const claimed = await db.transaction(async (tx) => {
    const won = await markInvitationAccepted(invitation.id, tx);
    if (!won) return null;
    // Through `assertOrgRole` because this is where a stored invitation role
    // becomes an `org_members.role`: a pending invitation still carrying the
    // retired value must fail loudly naming the script, not create a member
    // nobody can authenticate.
    await addMember(
      invitation.orgId,
      session.user.id,
      assertOrgRole(invitation.role) as AssignableOrgRole,
      tx,
    );
    // Same transaction as the claim: an invitation that granted spaces must
    // never be spent while leaving the invitee out of them.
    return applyInvitationSpaceAssignments(tx, {
      orgId: invitation.orgId,
      userId: session.user.id,
      addedBy: invitation.invitedBy,
      assignments: invitation.spaceAssignments,
    });
  });

  if (!claimed) {
    // A concurrent accept consumed the token between our read and our claim.
    throw gone("invitation_accepted", "Invitation already accepted");
  }

  // Acceptance attribution. The `org_invitations` row records only THAT it was
  // accepted — its `accepted_by` / `accepted_at` columns were dropped in
  // migration 0055 because nothing read them, on the stated grounds that "who
  // accepted it and when is in the audit log". Nothing wrote that audit row,
  // so the claim was false and dropping the columns lost the attribution
  // outright; this is the write that makes it true. It joins the three
  // sibling invitation mutations (`org.invitation_created` / `_cancelled` /
  // `_role_updated` in `routes/organizations.ts`) under the same
  // `resourceType`. Recorded only AFTER the claim is won, so a loser of the
  // concurrent race never logs an acceptance it did not perform.
  //
  // `recordAudit`, not `recordAuditFromContext`: this route is mounted BEFORE
  // the platform auth + org-context middleware (the invitee is not yet a
  // member of the org they are joining), so the context carries neither
  // `orgId` nor `user` — the wrapper would attribute this to `system` and then
  // drop the row for want of an orgId. Both come from the values this handler
  // already verified. The insert is best-effort inside `recordAudit`: the
  // membership is committed either way.
  await recordAudit({
    orgId: invitation.orgId,
    actorType: "user",
    actorId: session.user.id,
    action: "org.invitation_accepted",
    resourceType: "invitation",
    resourceId: invitation.id,
    after: {
      email: invitation.email,
      role: invitation.role,
      space_assignments: claimed,
    },
    ip: getClientIpFromRequest(c.req.raw),
    userAgent: c.req.header("user-agent") ?? null,
  });

  // Bare joined-org resource — same shape as the items in GET /api/orgs
  // (issue #657). The web accept page reads `id` to pin the org store.
  return c.json({
    id: org.id,
    name: org.name,
    slug: org.slug,
    role: invitation.role,
    permissions: listedOrgPermissions(assertOrgRole(invitation.role)),
    createdAt: org.createdAt,
  });
});

export default router;
