// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { apiKeyOrgScopeGuard } from "../middleware/guards.ts";
import {
  createOrganization,
  getUserOrganizations,
  getOrgById,
  updateOrganization,
  deleteOrganization,
  getOrgMembers,
  getOrgMember,
  getOrgMemberWithProfile,
  removeMember,
  updateMemberRole,
  isSlugAvailable,
  getOrgSettings,
  updateOrgSettings,
  orgSettingsSchema,
} from "../services/organizations.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { toSlug, SLUG_REGEX } from "@appstrate/core/naming";
import { ApiError, forbidden, invalidRequest, notFound } from "../lib/errors.ts";
import { readJsonBody } from "../lib/request-body.ts";
import { listResponse } from "../lib/list-response.ts";
import {
  createInvitation,
  getOrgInvitations,
  cancelInvitation,
  updateInvitationRole,
  ASSIGNABLE_ROLES,
} from "../services/invitations.ts";
import { provisionDefaultAgentForOrg } from "../services/default-agent.ts";
import { effectiveOrgStorageLimit } from "../services/documents.ts";
import { getEnv } from "@appstrate/env";
import { isPlatformAdmin } from "@appstrate/db/auth-policy";
import { createDefaultApplication } from "../services/applications.ts";
import { emitEvent } from "../lib/modules/module-loader.ts";
import { logger } from "../lib/logger.ts";
import { recordAuditFromContext } from "../services/audit.ts";

export const createOrgSchema = z.object({
  name: z.string().min(1, "Name is required"),
  slug: z.string().regex(SLUG_REGEX, "Invalid slug (kebab-case required)").optional(),
});

export const updateOrgSchema = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().regex(SLUG_REGEX, "Invalid slug (kebab-case required)").optional(),
});

export const addMemberSchema = z.object({
  email: z.email("Email is required"),
  role: z.enum(ASSIGNABLE_ROLES).default("member"),
});

export const updateRoleSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES),
});

/**
 * Gate an org-administration route on the caller's org role.
 *
 * API keys are rejected outright: none of the operations gated here
 * (org update/delete, member removal, role changes, settings writes) map
 * to an API-key-grantable scope — `org:*` / `members:*` are deliberately
 * absent from `API_KEY_ALLOWED_SCOPES` (lib/permissions.ts). Checking the
 * creator's LIVE membership row for a key would therefore let ANY key,
 * whatever its scopes (e.g. `runs:read`), inherit its creator's full
 * org-admin rights — a privilege escalation past the scope intersection
 * computed by the auth pipeline. Cookie sessions (and any other
 * human-session auth method) keep the plain membership-role check.
 */
async function requireOrgRole(
  c: Context<AppEnv>,
  orgId: string,
  roles: string[],
  message: string,
): Promise<void> {
  if (c.get("authMethod") === "api_key") {
    throw forbidden("API keys cannot perform organization administration");
  }
  const member = await getOrgMember(orgId, c.get("user").id);
  if (!member || !roles.includes(member.role)) {
    throw forbidden(message);
  }
}

const router = new Hono<AppEnv>();

router.use("/:orgId", apiKeyOrgScopeGuard);
router.use("/:orgId/*", apiKeyOrgScopeGuard);

// GET /api/orgs — list orgs for the current user (no org context needed)
router.get("/", async (c) => {
  const user = c.get("user");
  // API keys see only their bound org — filter at the DB level so a
  // compromised key cannot cause enumeration queries across every org the
  // creator belongs to.
  const orgIdFilter = c.get("authMethod") === "api_key" ? c.get("orgId") : undefined;
  const orgs = await getUserOrganizations(user.id, orgIdFilter);

  return c.json(
    listResponse(
      orgs.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        role: o.role,
        createdAt: o.createdAt,
      })),
    ),
  );
});

// POST /api/orgs — create an organization (no org context needed)
router.post("/", async (c) => {
  if (c.get("authMethod") === "api_key") {
    throw forbidden("API keys cannot create organizations");
  }
  const user = c.get("user");
  // Self-hosting closed mode (issue #228): when org creation is disabled
  // platform-wide, only platform admins (AUTH_PLATFORM_ADMIN_EMAILS) may
  // create new organizations. The OrgGate webapp branch surfaces a
  // "waiting for invitation" page to non-admin users with no org.
  if (getEnv().AUTH_DISABLE_ORG_CREATION && !isPlatformAdmin(user.email)) {
    throw forbidden("Organization creation is disabled on this instance");
  }
  const data = await readJsonBody(c, createOrgSchema);

  const slug = data.slug?.trim() || toSlug(data.name, 50);
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

  // Notify modules of org creation (non-fatal — errors isolated per module)
  await emitEvent("onOrgCreate", org.id, user.email);

  // Create default application for the new org (non-fatal)
  const defaultApp = await createDefaultApplication(org.id, user.id).catch((err) => {
    logger.warn("Failed to create default application for new org", {
      orgId: org.id,
      error: getErrorMessage(err),
    });
    return null;
  });

  // Provision default hello-world agent + install in default app (non-fatal)
  if (defaultApp) {
    await provisionDefaultAgentForOrg(org.id, org.slug, user.id, defaultApp.id).catch(() => {});
  }

  await recordAuditFromContext(c, {
    action: "org.created",
    resourceType: "org",
    resourceId: org.id,
    after: { name: org.name, slug: org.slug },
    orgIdOverride: org.id,
  });

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

// OrgDetail serializer — shared by GET /:orgId and PUT /:orgId so the update
// response is the exact same resource shape as the detail read.
async function buildOrgDetail(orgId: string) {
  const [org, members, invitations] = await Promise.all([
    getOrgById(orgId),
    getOrgMembers(orgId),
    getOrgInvitations(orgId),
  ]);
  if (!org) {
    throw notFound("Organization not found");
  }

  // Storage consumption vs. the org's document storage limit. `used_bytes` is
  // the transactionally-maintained `organizations.documents_bytes_used` counter.
  // `limit_bytes` is the raw per-org override (`documents_bytes_limit`), null
  // when no override is set. `effective_limit_bytes` is what the write path
  // actually enforces — the override, else the global `ORG_STORAGE_QUOTA_BYTES`,
  // else null (unlimited) — resolved through the same `effectiveOrgStorageLimit`
  // the documents service gates writes against.
  const storageQuota = getEnv().ORG_STORAGE_QUOTA_BYTES;
  const effectiveLimit = effectiveOrgStorageLimit(org.documentsBytesLimit, storageQuota);

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.createdAt,
    storage: {
      used_bytes: org.documentsBytesUsed,
      limit_bytes: org.documentsBytesLimit ?? null,
      effective_limit_bytes: effectiveLimit ?? null,
    },
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
  };
}

// GET /api/orgs/:orgId — org details + members
router.get("/:orgId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");

  const member = await getOrgMember(orgId, user.id);
  if (!member) {
    throw forbidden("Not a member of this organization");
  }

  return c.json(await buildOrgDetail(orgId));
});

// PUT /api/orgs/:orgId — update name/slug (owner only — org routes skip org context)
router.put("/:orgId", async (c) => {
  const orgId = c.req.param("orgId");

  await requireOrgRole(c, orgId, ["owner"], "Only the owner can modify the organization");

  const data = await readJsonBody(c, updateOrgSchema);

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

  await updateOrganization(orgId, {
    ...(data.name?.trim() ? { name: data.name.trim() } : {}),
    ...(data.slug ? { slug: data.slug } : {}),
  });

  await recordAuditFromContext(c, {
    action: "org.updated",
    resourceType: "org",
    resourceId: orgId,
    after: data as unknown as Record<string, unknown>,
    orgIdOverride: orgId,
  });

  // Bare updated resource — same OrgDetail serializer as GET /:orgId.
  return c.json(await buildOrgDetail(orgId));
});

// DELETE /api/orgs/:orgId — delete organization and all related data (owner only)
router.delete("/:orgId", async (c) => {
  const orgId = c.req.param("orgId");

  await requireOrgRole(c, orgId, ["owner"], "Only the owner can delete the organization");

  try {
    // Notify modules of org deletion (non-fatal — errors isolated per module, FK CASCADE handles cleanup)
    await emitEvent("onOrgDelete", orgId);

    await deleteOrganization(orgId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to delete organization";
    throw new ApiError({ status: 400, code: "delete_failed", title: "Bad Request", detail: msg });
  }

  // org_id on audit_events is denormalized (no FK), so this tombstone persists
  // after the org row is gone — the audit trail outlives the org by design.
  await recordAuditFromContext(c, {
    action: "org.deleted",
    resourceType: "org",
    resourceId: orgId,
    orgIdOverride: orgId,
  });

  return c.body(null, 204);
});

// POST /api/orgs/:orgId/members — invite a member (admin+)
//
// Always creates a pending invitation — for new and existing users alike.
// The invitee joins by opening the invite link, authenticating through the
// standard login/signup flow, then explicitly accepting. This keeps a single,
// consent-explicit join path: no silent direct-add of existing users, no
// magic-link side channel. When SMTP is configured the invitation email is
// sent; otherwise the admin shares the returned token/link out of band.
router.post("/:orgId/members", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");

  await requireOrgRole(c, orgId, ["owner", "admin"], "Admin access required to invite members");

  const data = await readJsonBody(c, addMemberSchema);
  const role = data.role;

  try {
    const invitation = await createInvitation({
      email: data.email.trim(),
      orgId,
      role,
      invitedBy: user.id,
    });

    await recordAuditFromContext(c, {
      action: "org.invitation_created",
      resourceType: "invitation",
      resourceId: invitation.id,
      after: { email: invitation.email, role },
      orgIdOverride: orgId,
    });

    // Bare OrgInvitationInfo — same shape as the items in the invitations
    // list in GET /orgs/:orgId. The `token` is exposed because this endpoint
    // is admin-gated (it lets a no-SMTP admin copy the invite link).
    return c.json(
      {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        token: invitation.token,
        expiresAt: invitation.expiresAt?.toISOString(),
        createdAt: invitation.createdAt?.toISOString(),
      },
      201,
    );
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
  const orgId = c.req.param("orgId");
  const invitationId = c.req.param("invitationId");

  await requireOrgRole(c, orgId, ["owner", "admin"], "Admin access required");
  await cancelInvitation(invitationId, orgId);
  await recordAuditFromContext(c, {
    action: "org.invitation_cancelled",
    resourceType: "invitation",
    resourceId: invitationId,
    orgIdOverride: orgId,
  });
  return c.body(null, 204);
});

// PUT /api/orgs/:orgId/invitations/:invitationId — change invitation role (owner only)
router.put("/:orgId/invitations/:invitationId", async (c) => {
  const orgId = c.req.param("orgId");
  const invitationId = c.req.param("invitationId");

  await requireOrgRole(c, orgId, ["owner"], "Only the owner can change roles");

  const data = await readJsonBody(c, updateRoleSchema);

  const updated = await updateInvitationRole(invitationId, orgId, data.role);
  if (!updated) {
    throw notFound("Invitation not found or already accepted");
  }

  await recordAuditFromContext(c, {
    action: "org.invitation_role_updated",
    resourceType: "invitation",
    resourceId: invitationId,
    after: { role: data.role },
    orgIdOverride: orgId,
  });

  // Bare updated resource — same serializer as the invitations list in
  // GET /orgs/:orgId (issue #657). `token` is included because the
  // endpoint is owner-gated, consistent with the list.
  return c.json({
    id: updated.id,
    email: updated.email,
    role: updated.role,
    token: updated.token,
    expiresAt: updated.expiresAt?.toISOString(),
    createdAt: updated.createdAt?.toISOString(),
  });
});

// DELETE /api/orgs/:orgId/members/:userId — remove a member (admin+)
router.delete("/:orgId/members/:userId", async (c) => {
  const orgId = c.req.param("orgId");
  const targetUserId = c.req.param("userId");

  await requireOrgRole(c, orgId, ["owner", "admin"], "Admin access required to remove members");

  const target = await getOrgMember(orgId, targetUserId);
  if (!target) {
    throw notFound("Member not found");
  }
  if (target.role === "owner") {
    throw forbidden("Cannot remove the owner");
  }

  await removeMember(orgId, targetUserId);
  await recordAuditFromContext(c, {
    action: "org.member_removed",
    resourceType: "member",
    resourceId: targetUserId,
    orgIdOverride: orgId,
  });
  return c.body(null, 204);
});

// PUT /api/orgs/:orgId/members/:userId — change role (owner only)
router.put("/:orgId/members/:userId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");
  const targetUserId = c.req.param("userId");

  await requireOrgRole(c, orgId, ["owner"], "Only the owner can change roles");

  const data = await readJsonBody(c, updateRoleSchema);

  // Cannot change own role
  if (targetUserId === user.id) {
    throw forbidden("Cannot change your own role");
  }

  const target = await getOrgMember(orgId, targetUserId);
  if (!target) {
    throw notFound("Member not found");
  }

  await updateMemberRole(orgId, targetUserId, data.role);
  await recordAuditFromContext(c, {
    action: "org.member_role_updated",
    resourceType: "member",
    resourceId: targetUserId,
    after: { role: data.role },
    orgIdOverride: orgId,
  });

  // Bare updated resource — same serializer as the members list in
  // GET /orgs/:orgId (issue #657).
  const updated = await getOrgMemberWithProfile(orgId, targetUserId);
  if (!updated) {
    throw notFound("Member not found");
  }
  return c.json({
    userId: updated.userId,
    role: updated.role,
    joinedAt: updated.joinedAt,
    displayName: updated.displayName,
    email: updated.email,
  });
});

// GET /api/orgs/:orgId/settings — get org settings (any member)
router.get("/:orgId/settings", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");

  // Membership gate — without it any cookie-session user could read an
  // arbitrary org's settings by passing its id (apiKeyOrgScopeGuard only
  // pins API keys, not sessions). Mirrors the PUT handler below.
  const member = await getOrgMember(orgId, user.id);
  if (!member) throw forbidden("Not a member of this organization");

  const settings = await getOrgSettings(orgId);
  return c.json(settings);
});

// PUT /api/orgs/:orgId/settings — update org settings (owner/admin)
router.put("/:orgId/settings", async (c) => {
  const orgId = c.req.param("orgId");

  await requireOrgRole(c, orgId, ["owner", "admin"], "Admin access required to update settings");

  const data = await readJsonBody(c, orgSettingsSchema.partial());

  const settings = await updateOrgSettings(orgId, data);
  await recordAuditFromContext(c, {
    action: "org.settings_updated",
    resourceType: "org",
    resourceId: orgId,
    after: data as unknown as Record<string, unknown>,
    orgIdOverride: orgId,
  });
  return c.json(settings);
});

export default router;
