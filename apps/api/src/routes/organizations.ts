// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
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
  orgSettingsSchema,
} from "../services/organizations.ts";
import { ApiError, forbidden, invalidRequest, notFound, parseBody } from "../lib/errors.ts";
import {
  createInvitation,
  sendMagicLinkInvitation,
  getOrgInvitations,
  cancelInvitation,
  updateInvitationRole,
  ASSIGNABLE_ROLES,
} from "../services/invitations.ts";
import { getAppConfig } from "../lib/app-config.ts";
import { provisionDefaultAgentForOrg } from "../services/default-agent.ts";
import { createDefaultApplication } from "../services/applications.ts";
import { getCloudModule } from "../lib/cloud-loader.ts";
import { logger } from "../lib/logger.ts";

const createOrgSchema = z.object({
  name: z.string().min(1, "Name is required"),
  slug: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "Invalid slug (kebab-case required)")
    .optional(),
});

const updateOrgSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "Invalid slug (kebab-case required)")
    .optional(),
});

const addMemberSchema = z.object({
  email: z.string().email("Email is required"),
  role: z.enum(ASSIGNABLE_ROLES).default("member"),
});

const updateRoleSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES),
});

async function requireOrgRole(
  orgId: string,
  userId: string,
  roles: string[],
  message: string,
): Promise<void> {
  const member = await getOrgMember(orgId, userId);
  if (!member || !roles.includes(member.role)) {
    throw forbidden(message);
  }
}

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
  const body = await c.req.json();
  const data = parseBody(createOrgSchema, body);

  const slug = data.slug?.trim() || slugify(data.name);
  if (!slug) {
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

  const org = await createOrganization(data.name.trim(), slug, user.id);

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
  await provisionDefaultAgentForOrg(org.id, org.slug, user.id).catch(() => {});

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

// PUT /api/orgs/:orgId — update name/slug (owner only — org routes skip org context)
router.put("/:orgId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");

  await requireOrgRole(orgId, user.id, ["owner"], "Only the owner can modify the organization");

  const body = await c.req.json();
  const data = parseBody(updateOrgSchema, body);

  if (data.slug) {
    if (!(await isSlugAvailable(data.slug))) {
      throw new ApiError({
        status: 400,
        code: "slug_taken",
        title: "Bad Request",
        detail: `Slug '${data.slug}' is already in use`,
      });
    }
  }

  const updated = await updateOrganization(orgId, {
    ...(data.name?.trim() ? { name: data.name.trim() } : {}),
    ...(data.slug ? { slug: data.slug } : {}),
  });

  return c.json(updated);
});

// DELETE /api/orgs/:orgId — delete organization and all related data (owner only)
router.delete("/:orgId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");

  await requireOrgRole(orgId, user.id, ["owner"], "Only the owner can delete the organization");

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

// POST /api/orgs/:orgId/members — invite a member (admin+)
router.post("/:orgId/members", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");

  await requireOrgRole(
    orgId,
    user.id,
    ["owner", "admin"],
    "Admin access required to invite members",
  );

  const body = await c.req.json();
  const data = parseBody(addMemberSchema, body);

  const role = data.role;

  const targetUser = await findUserByEmail(data.email.trim());

  if (targetUser) {
    if (getAppConfig().features.smtp) {
      // User exists + SMTP → create invitation with magic link (auto-auth on click)
      const invitation = await createInvitation({
        email: data.email.trim(),
        orgId,
        role,
        invitedBy: user.id,
        skipEmail: true,
      });
      void sendMagicLinkInvitation(invitation);
      return c.json({ invited: true, email: invitation.email, role }, 201);
    }
    // User exists + no SMTP → add directly
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
      email: data.email.trim(),
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

// DELETE /api/orgs/:orgId/invitations/:invitationId — cancel an invitation (admin+)
router.delete("/:orgId/invitations/:invitationId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");
  const invitationId = c.req.param("invitationId");

  await requireOrgRole(orgId, user.id, ["owner", "admin"], "Admin access required");
  await cancelInvitation(invitationId, orgId);
  return c.json({ ok: true });
});

// PUT /api/orgs/:orgId/invitations/:invitationId — change invitation role (owner only)
router.put("/:orgId/invitations/:invitationId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");
  const invitationId = c.req.param("invitationId");

  await requireOrgRole(orgId, user.id, ["owner"], "Only the owner can change roles");

  const body = await c.req.json();
  const data = parseBody(updateRoleSchema, body);

  const updated = await updateInvitationRole(invitationId, orgId, data.role);
  if (!updated) {
    throw notFound("Invitation not found or already accepted");
  }

  return c.json({ id: updated.id, role: updated.role });
});

// DELETE /api/orgs/:orgId/members/:userId — remove a member (admin+)
router.delete("/:orgId/members/:userId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");
  const targetUserId = c.req.param("userId");

  await requireOrgRole(
    orgId,
    user.id,
    ["owner", "admin"],
    "Admin access required to remove members",
  );

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

  await requireOrgRole(orgId, user.id, ["owner"], "Only the owner can change roles");

  const body = await c.req.json();
  const data = parseBody(updateRoleSchema, body);

  // Cannot change own role
  if (targetUserId === user.id) {
    throw forbidden("Cannot change your own role");
  }

  await updateMemberRole(orgId, targetUserId, data.role);
  return c.json({ userId: targetUserId, role: data.role });
});

// GET /api/orgs/:orgId/settings — get org settings
router.get("/:orgId/settings", async (c) => {
  const orgId = c.req.param("orgId");

  const settings = await getOrgSettings(orgId);
  return c.json(settings);
});

// PUT /api/orgs/:orgId/settings — update org settings (owner/admin)
router.put("/:orgId/settings", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");

  await requireOrgRole(
    orgId,
    user.id,
    ["owner", "admin"],
    "Admin access required to update settings",
  );

  const raw = await c.req.json();
  const data = parseBody(orgSettingsSchema.partial(), raw);

  const settings = await updateOrgSettings(orgId, data);
  return c.json(settings);
});

export default router;
