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
} from "../services/organizations.ts";
import {
  createInvitation,
  getOrgInvitations,
  cancelInvitation,
  updateInvitationRole,
} from "../services/invitations.ts";
import { provisionDefaultFlowForOrg } from "../services/default-flow.ts";

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
    return c.json({ error: "VALIDATION_ERROR", message: "Name is required" }, 400);
  }

  const slug = body.slug?.trim() || slugify(body.name);
  if (!slug || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    return c.json(
      { error: "VALIDATION_ERROR", message: "Invalid slug (kebab-case required)" },
      400,
    );
  }

  if (!(await isSlugAvailable(slug))) {
    return c.json({ error: "SLUG_TAKEN", message: `Slug '${slug}' is already in use` }, 400);
  }

  const org = await createOrganization(body.name.trim(), slug, user.id);

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
    return c.json({ error: "FORBIDDEN", message: "Not a member of this organization" }, 403);
  }

  const [org, members, invitations] = await Promise.all([
    getOrgById(orgId),
    getOrgMembers(orgId),
    getOrgInvitations(orgId),
  ]);
  if (!org) {
    return c.json({ error: "NOT_FOUND", message: "Organization not found" }, 404);
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
    return c.json(
      { error: "FORBIDDEN", message: "Only the owner can modify the organization" },
      403,
    );
  }

  const body = await c.req.json<{ name?: string; slug?: string }>();

  if (body.slug) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(body.slug)) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "Invalid slug (kebab-case required)" },
        400,
      );
    }
    if (!(await isSlugAvailable(body.slug))) {
      return c.json({ error: "SLUG_TAKEN", message: `Slug '${body.slug}' is already in use` }, 400);
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
    return c.json(
      { error: "FORBIDDEN", message: "Only the owner can delete the organization" },
      403,
    );
  }

  try {
    await deleteOrganization(orgId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to delete organization";
    return c.json({ error: "DELETE_FAILED", message: msg }, 400);
  }

  return c.json({ ok: true });
});

// POST /api/orgs/:orgId/members — add a member by email (admin/owner only)
router.post("/:orgId/members", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");

  const member = await getOrgMember(orgId, user.id);
  if (!member || !["owner", "admin"].includes(member.role)) {
    return c.json({ error: "FORBIDDEN", message: "Only admins can add members" }, 403);
  }

  const body = await c.req.json<{ email: string; role?: string }>();
  if (!body.email?.trim()) {
    return c.json({ error: "VALIDATION_ERROR", message: "Email is required" }, 400);
  }

  const role = (body.role as "member" | "admin") || "member";
  if (!["member", "admin"].includes(role)) {
    return c.json({ error: "VALIDATION_ERROR", message: "Role must be 'member' or 'admin'" }, 400);
  }

  const targetUser = await findUserByEmail(body.email.trim());

  if (targetUser) {
    // User exists — add directly
    try {
      await addMember(orgId, targetUser.id, role);
    } catch (err) {
      return c.json(
        {
          error: "ADD_MEMBER_FAILED",
          message: err instanceof Error ? err.message : "Failed to add member",
        },
        400,
      );
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
    return c.json(
      {
        error: "INVITATION_FAILED",
        message: err instanceof Error ? err.message : "Failed to send invitation",
      },
      500,
    );
  }
});

// DELETE /api/orgs/:orgId/invitations/:invitationId — cancel an invitation (admin/owner only)
router.delete("/:orgId/invitations/:invitationId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");
  const invitationId = c.req.param("invitationId");

  const member = await getOrgMember(orgId, user.id);
  if (!member || !["owner", "admin"].includes(member.role)) {
    return c.json({ error: "FORBIDDEN", message: "Only admins can cancel invitations" }, 403);
  }

  await cancelInvitation(invitationId);
  return c.json({ ok: true });
});

// PUT /api/orgs/:orgId/invitations/:invitationId — change invitation role (owner only)
router.put("/:orgId/invitations/:invitationId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");
  const invitationId = c.req.param("invitationId");

  const member = await getOrgMember(orgId, user.id);
  if (!member || member.role !== "owner") {
    return c.json({ error: "FORBIDDEN", message: "Only the owner can change roles" }, 403);
  }

  const body = await c.req.json<{ role: string }>();
  if (!["member", "admin"].includes(body.role)) {
    return c.json({ error: "VALIDATION_ERROR", message: "Role must be 'member' or 'admin'" }, 400);
  }

  const updated = await updateInvitationRole(invitationId, orgId, body.role as "member" | "admin");
  if (!updated) {
    return c.json({ error: "NOT_FOUND", message: "Invitation not found or already accepted" }, 404);
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
    return c.json({ error: "FORBIDDEN", message: "Only admins can remove members" }, 403);
  }

  // Cannot remove the owner
  const target = await getOrgMember(orgId, targetUserId);
  if (!target) {
    return c.json({ error: "NOT_FOUND", message: "Member not found" }, 404);
  }
  if (target.role === "owner") {
    return c.json({ error: "FORBIDDEN", message: "Cannot remove the owner" }, 403);
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
    return c.json({ error: "FORBIDDEN", message: "Only the owner can change roles" }, 403);
  }

  const body = await c.req.json<{ role: string }>();
  if (!["member", "admin"].includes(body.role)) {
    return c.json({ error: "VALIDATION_ERROR", message: "Role must be 'member' or 'admin'" }, 400);
  }

  // Cannot change own role
  if (targetUserId === user.id) {
    return c.json({ error: "FORBIDDEN", message: "Cannot change your own role" }, 400);
  }

  await updateMemberRole(orgId, targetUserId, body.role as "member" | "admin");
  return c.json({ userId: targetUserId, role: body.role });
});

export default router;
