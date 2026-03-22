import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  createOrganization,
  getUserOrganizations,
  getOrgById,
  updateOrganization,
  deleteOrganization,
  getOrgMembers,
  getOrgMember,
  addMember,
  removeMember,
  updateMemberRole,
  findUserByEmail,
  slugify,
  isSlugAvailable,
  getOrgSettings,
  updateOrgSettings,
} from "../services/organizations.ts";
import { validateDomainList } from "../services/redirect-validation.ts";
import { ApiError, forbidden, invalidRequest, notFound } from "../lib/errors.ts";
import {
  createInvitation,
  getOrgInvitations,
  cancelInvitation,
  updateInvitationRole,
} from "../services/invitations.ts";
import { provisionDefaultFlowForOrg } from "../services/default-flow.ts";
import { createDefaultApplication } from "../services/applications.ts";
import { getCloudModule } from "../lib/cloud-loader.ts";
import { logger } from "../lib/logger.ts";

const router = new Hono<AppEnv>();

// GET /api/orgs — list orgs for the current user (no org context needed)
router.get("/", async (c) => {
  const user = c.get("user");
  const orgs = await getUserOrganizations(user.id);

  return c.json({
    organizations: orgs.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      role: o.role,
      createdAt: o.createdAt,
    })),
  });
});

// POST /api/orgs — create an organization (no org context needed)
router.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ name: string; slug?: string }>();

  if (!body.name?.trim()) {
    throw invalidRequest("Name is required");
  }

  const slug = body.slug?.trim() || slugify(body.name);
  if (!slug || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw invalidRequest("Invalid slug (kebab-case required)");
  }

  if (!(await isSlugAvailable(slug))) {
    throw new ApiError({
      status: 400,
      code: "slug_taken",
      title: "Bad Request",
      detail: `Slug '${slug}' is already in use`,
    });
  }

  const org = await createOrganization(body.name.trim(), slug, user.id);

  // Cloud billing: create billing account with free tier credits (non-fatal)
  await getCloudModule()
    ?.cloudHooks.onOrgCreated(org.id, user.email)
    .catch((err) => {
      logger.error("Failed to create billing account for new org", {
        orgId: org.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // Create default application for the new org (non-fatal)
  await createDefaultApplication(org.id, user.id).catch((err) => {
    logger.warn("Failed to create default application for new org", {
      orgId: org.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Provision default hello-world flow for the new org (non-fatal)
  await provisionDefaultFlowForOrg(org.id, org.slug, user.id).catch(() => {});

  return c.json(
    {
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: "owner",
      createdAt: org.createdAt,
    },
    201,
  );
});

// --- Routes below require org context (orgId from params, verified via membership) ---

// GET /api/orgs/:orgId — org details + members
router.get("/:orgId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");

  const member = await getOrgMember(orgId, user.id);
  if (!member) {
    throw forbidden("Not a member of this organization");
  }

  const [org, members, invitations] = await Promise.all([
    getOrgById(orgId),
    getOrgMembers(orgId),
    getOrgInvitations(orgId),
  ]);
  if (!org) {
    throw notFound("Organization not found");
  }

  return c.json({
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.createdAt,
    members: members.map((m) => ({
      userId: m.userId,
      role: m.role,
      joinedAt: m.joinedAt,
      displayName: m.displayName,
      email: m.email,
    })),
    invitations: invitations.map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      token: inv.token,
      expiresAt: inv.expiresAt?.toISOString(),
      createdAt: inv.createdAt?.toISOString(),
    })),
  });
});

// PUT /api/orgs/:orgId — update name/slug (owner only)
router.put("/:orgId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");

  const member = await getOrgMember(orgId, user.id);
  if (!member || member.role !== "owner") {
    throw forbidden("Only the owner can modify the organization");
  }

  const body = await c.req.json<{ name?: string; slug?: string }>();

  if (body.slug) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(body.slug)) {
      throw invalidRequest("Invalid slug (kebab-case required)");
    }
    if (!(await isSlugAvailable(body.slug))) {
      throw new ApiError({
        status: 400,
        code: "slug_taken",
        title: "Bad Request",
        detail: `Slug '${body.slug}' is already in use`,
      });
    }
  }

  const updated = await updateOrganization(orgId, {
    ...(body.name?.trim() ? { name: body.name.trim() } : {}),
    ...(body.slug ? { slug: body.slug } : {}),
  });

  return c.json(updated);
});

// DELETE /api/orgs/:orgId — delete organization and all related data (owner only)
router.delete("/:orgId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");

  const member = await getOrgMember(orgId, user.id);
  if (!member || member.role !== "owner") {
    throw forbidden("Only the owner can delete the organization");
  }

  try {
    // Cloud billing: clean up billing account before org deletion (non-fatal — FK CASCADE handles cleanup)
    await getCloudModule()
      ?.cloudHooks.onOrgDeleted(orgId)
      .catch((err) => {
        logger.warn("Failed to clean up billing account before org deletion", {
          orgId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    await deleteOrganization(orgId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to delete organization";
    throw new ApiError({ status: 400, code: "delete_failed", title: "Bad Request", detail: msg });
  }

  return c.json({ ok: true });
});

// POST /api/orgs/:orgId/members — add a member by email (admin/owner only)
router.post("/:orgId/members", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");

  const member = await getOrgMember(orgId, user.id);
  if (!member || !["owner", "admin"].includes(member.role)) {
    throw forbidden("Only admins can add members");
  }

  const body = await c.req.json<{ email: string; role?: string }>();
  if (!body.email?.trim()) {
    throw invalidRequest("Email is required");
  }

  const role = (body.role as "member" | "admin") || "member";
  if (!["member", "admin"].includes(role)) {
    throw invalidRequest("Role must be 'member' or 'admin'");
  }

  const targetUser = await findUserByEmail(body.email.trim());

  if (targetUser) {
    // User exists — add directly
    try {
      await addMember(orgId, targetUser.id, role);
    } catch (err) {
      throw new ApiError({
        status: 400,
        code: "add_member_failed",
        title: "Bad Request",
        detail: err instanceof Error ? err.message : "Failed to add member",
      });
    }
    return c.json({ userId: targetUser.id, role, added: true }, 201);
  }

  // User doesn't exist — create invitation
  try {
    const invitation = await createInvitation({
      email: body.email.trim(),
      orgId,
      role,
      invitedBy: user.id,
    });

    return c.json({ invited: true, email: invitation.email, role, token: invitation.token }, 201);
  } catch (err) {
    throw new ApiError({
      status: 500,
      code: "invitation_failed",
      title: "Internal Error",
      detail: err instanceof Error ? err.message : "Failed to send invitation",
    });
  }
});

// DELETE /api/orgs/:orgId/invitations/:invitationId — cancel an invitation (admin/owner only)
router.delete("/:orgId/invitations/:invitationId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");
  const invitationId = c.req.param("invitationId");

  const member = await getOrgMember(orgId, user.id);
  if (!member || !["owner", "admin"].includes(member.role)) {
    throw forbidden("Only admins can cancel invitations");
  }

  await cancelInvitation(invitationId, orgId);
  return c.json({ ok: true });
});

// PUT /api/orgs/:orgId/invitations/:invitationId — change invitation role (owner only)
router.put("/:orgId/invitations/:invitationId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");
  const invitationId = c.req.param("invitationId");

  const member = await getOrgMember(orgId, user.id);
  if (!member || member.role !== "owner") {
    throw forbidden("Only the owner can change roles");
  }

  const body = await c.req.json<{ role: string }>();
  if (!["member", "admin"].includes(body.role)) {
    throw invalidRequest("Role must be 'member' or 'admin'");
  }

  const updated = await updateInvitationRole(invitationId, orgId, body.role as "member" | "admin");
  if (!updated) {
    throw notFound("Invitation not found or already accepted");
  }

  return c.json({ id: updated.id, role: updated.role });
});

// DELETE /api/orgs/:orgId/members/:userId — remove a member (admin/owner only)
router.delete("/:orgId/members/:userId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");
  const targetUserId = c.req.param("userId");

  const member = await getOrgMember(orgId, user.id);
  if (!member || !["owner", "admin"].includes(member.role)) {
    throw forbidden("Only admins can remove members");
  }

  // Cannot remove the owner
  const target = await getOrgMember(orgId, targetUserId);
  if (!target) {
    throw notFound("Member not found");
  }
  if (target.role === "owner") {
    throw forbidden("Cannot remove the owner");
  }

  await removeMember(orgId, targetUserId);
  return c.json({ ok: true });
});

// PUT /api/orgs/:orgId/members/:userId — change role (owner only)
router.put("/:orgId/members/:userId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");
  const targetUserId = c.req.param("userId");

  const member = await getOrgMember(orgId, user.id);
  if (!member || member.role !== "owner") {
    throw forbidden("Only the owner can change roles");
  }

  const body = await c.req.json<{ role: string }>();
  if (!["member", "admin"].includes(body.role)) {
    throw invalidRequest("Role must be 'member' or 'admin'");
  }

  // Cannot change own role
  if (targetUserId === user.id) {
    throw forbidden("Cannot change your own role");
  }

  await updateMemberRole(orgId, targetUserId, body.role as "member" | "admin");
  return c.json({ userId: targetUserId, role: body.role });
});

// GET /api/orgs/:orgId/settings — get org settings
router.get("/:orgId/settings", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");

  const member = await getOrgMember(orgId, user.id);
  if (!member || !["owner", "admin"].includes(member.role)) {
    throw forbidden("Admin access required");
  }

  const settings = await getOrgSettings(orgId);
  return c.json(settings);
});

// PUT /api/orgs/:orgId/settings — update org settings (merge)
router.put("/:orgId/settings", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");

  const member = await getOrgMember(orgId, user.id);
  if (!member || !["owner", "admin"].includes(member.role)) {
    throw forbidden("Admin access required");
  }

  const body = await c.req.json<{ allowedRedirectDomains?: string[] }>();

  if (body.allowedRedirectDomains !== undefined) {
    const validationError = validateDomainList(body.allowedRedirectDomains);
    if (validationError) {
      throw invalidRequest(validationError);
    }
  }

  const settings = await updateOrgSettings(orgId, body);
  return c.json(settings);
});

export default router;
