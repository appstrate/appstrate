// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { Context, Next } from "hono";
import { z } from "zod";
import type { AppEnv, OrgRole } from "../types/index.ts";
import { apiKeyOrgScopeGuard } from "../middleware/guards.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import {
  assertOrgRole,
  effectivePermissions,
  listedOrgPermissions,
  orgPermissions,
} from "../lib/permissions.ts";
import {
  createOrganization,
  getUserOrganizations,
  getOrgById,
  updateOrganization,
  assertOrgDeletable,
  deleteOrganization,
  getOrgMembers,
  getOrgMember,
  getOrgMemberWithProfile,
  removeMember,
  updateMemberRole,
  isSlugAvailable,
  getOrgSettings,
  updateOrgSettings,
  orgSettingsPatchSchema,
} from "../services/organizations.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { toSlug, SLUG_REGEX } from "@appstrate/core/naming";
import { SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import { ApiError, forbidden, invalidRequest, notFound } from "../lib/errors.ts";
import {
  CURRENT_API_VERSION,
  isVersionSupported,
  unsupportedApiVersion,
} from "../lib/api-versions.ts";
import { readJsonBody } from "../lib/request-body.ts";
import { listResponse } from "../lib/list-response.ts";
import {
  assertSpaceAssignmentsValid,
  createInvitation,
  getOrgInvitations,
  getPendingInvitation,
  cancelInvitation,
  updateInvitation,
} from "../services/invitations.ts";
import { provisionDefaultAgentForOrg } from "../services/default-agent.ts";
import { effectiveOrgStorageLimit } from "../services/files.ts";
import { getEnv } from "@appstrate/env";
import { isPlatformAdmin } from "@appstrate/db/auth-policy";
import { createDefaultSpace } from "../services/spaces.ts";
import { emitEvent } from "../lib/modules/module-loader.ts";
import { logger } from "../lib/logger.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import {
  ASSIGNABLE_ORG_ROLES,
  assignableRolesForMember,
  canRemoveMember,
} from "@appstrate/shared-types";

export const createOrgSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    slug: z.string().regex(SLUG_REGEX, "Invalid slug (kebab-case required)").optional(),
  })
  .strict();

export const updateOrgSchema = z
  .object({
    name: z.string().min(1).optional(),
    slug: z.string().regex(SLUG_REGEX, "Invalid slug (kebab-case required)").optional(),
  })
  .strict();

/**
 * One space membership an invitation applies on accept: a space plus exactly
 * one role reference. Same either/or shape (and same message) as the
 * `/api/spaces/:id/members` bodies — the two write paths differ only in when
 * the row lands.
 */
const spaceAssignmentSchema = z
  .object({
    space_id: z.string().min(1),
    preset_role: z.enum(SPACE_ROLE_PRESETS).optional(),
    custom_role_id: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => (v.preset_role === undefined) !== (v.custom_role_id === undefined), {
    message: "exactly one of preset_role or custom_role_id is required",
  });

export const addMemberSchema = z
  .object({
    email: z.email("Email is required"),
    role: z.enum(ASSIGNABLE_ORG_ROLES).default("member"),
    space_assignments: z.array(spaceAssignmentSchema).default([]),
  })
  .strict();

export const updateRoleSchema = z
  .object({
    role: z.enum(ASSIGNABLE_ORG_ROLES),
  })
  .strict();

/**
 * A pending invitation's role AND its space assignments are editable until it
 * is accepted. Omitting `space_assignments` keeps the ones already stored —
 * the role rules are then re-checked against them, so changing the role to
 * `guest` on an invitation carrying no space is refused here just as it is at
 * invite time.
 */
export const updateInvitationSchema = z
  .object({
    role: z.enum(ASSIGNABLE_ORG_ROLES),
    space_assignments: z.array(spaceAssignmentSchema).optional(),
  })
  .strict();

/**
 * Write `permissions` for the organization named in the PATH.
 *
 * `/api/orgs/*` is exempt from `requireOrgContext` (`skipOrgContext` in
 * `lib/auth-pipeline.ts`) — the org comes from the path, not `X-Org-Id` —
 * so the pipeline's permission-resolution step never ran for a session
 * caller here and `requirePermission` below would have nothing to read.
 * Resolving from the path org's membership row is what lets these routes
 * be guarded like every other route in the codebase.
 *
 * The predicate mirrors the pipeline's own (`lib/auth-pipeline.ts`, the
 * permission-resolution middleware) exactly: derive from the membership row
 * for session auth and for strategies that set `deferOrgResolution`; every
 * other auth method already wrote a CEILING-LIMITED set (API-key scopes ∩
 * creator role, an OIDC/MCP token's scope claim) and keeps it. Overwriting
 * that with the membership row's full role set is a privilege escalation —
 * a bearer scoped to `runs:read` would inherit `org:delete` from the subject
 * behind it. `org:*` and `members:*` are not grantable to any of those
 * credentials, so the guards below refuse them; `apiKeyOrgScopeGuard` already
 * pins the path org to an API key's own.
 */
async function resolveOrgPathPermissions(c: Context<AppEnv>, next: Next) {
  if (c.get("authMethod") !== "session" && !c.get("deferOrgResolution")) return next();
  const orgId = c.req.param("orgId");
  if (!orgId) return next();
  const member = await getOrgMember(orgId, c.get("user").id);
  if (member) {
    const role = assertOrgRole(member.role);
    const org = orgPermissions(role);
    c.set("orgRole", role);
    c.set("orgPermissions", org);
    // `/api/orgs/*` is not space-scoped, so the org half is the whole answer —
    // a space-level guard can never be satisfied here, which is the property
    // the two-level split exists for.
    c.set("permissions", effectivePermissions({ orgPermissions: org }));
  }
  return next();
}

/**
 * Org role of the caller in the path org, as resolved above. The route's
 * permission guard has already proved the membership row exists; the throw is
 * the fail-closed backstop, not an expected branch.
 */
function actingOrgRole(c: Context<AppEnv>): OrgRole {
  const role = c.get("orgRole");
  if (!role) throw forbidden("Not a member of this organization");
  return role;
}

const router = new Hono<AppEnv>();

router.use("/:orgId", apiKeyOrgScopeGuard);
router.use("/:orgId/*", apiKeyOrgScopeGuard);
router.use("/:orgId", resolveOrgPathPermissions);
router.use("/:orgId/*", resolveOrgPathPermissions);

// GET /api/orgs — list orgs for the current user (no org context needed)
router.get("/", async (c) => {
  const user = c.get("user");
  // API keys see only their bound org — filter at the DB level so a
  // compromised key cannot cause enumeration queries across every org the
  // creator belongs to.
  const orgIdFilter = c.get("authMethod") === "api_key" ? c.get("orgId") : undefined;
  const orgs = await getUserOrganizations(user.id, orgIdFilter);
  const ceiling = c.get("scopeCeiling");

  return c.json(
    listResponse(
      orgs.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        role: o.role,
        // The caller's org-level reach in THAT org, ceiling-applied (RBAC spec
        // §6.5) — the SPA reads it instead of re-deriving anything from `role`.
        permissions: listedOrgPermissions(o.role, ceiling),
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

  // Create default space for the new org (non-fatal)
  const defaultSpace = await createDefaultSpace(org.id, user.id).catch((err) => {
    logger.warn("Failed to create default space for new org", {
      orgId: org.id,
      error: getErrorMessage(err),
    });
    return null;
  });

  // Provision default hello-world agent + install in default space (non-fatal)
  if (defaultSpace) {
    await provisionDefaultAgentForOrg(org.id, org.slug, user.id, defaultSpace.id).catch(() => {});
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

  // Storage consumption vs. the org's file storage limit. `used_bytes` is
  // the transactionally-maintained `organizations.files_bytes_used` counter.
  // `limit_bytes` is the raw per-org override (`files_bytes_limit`), null
  // when no override is set. `effective_limit_bytes` is what the write path
  // actually enforces — the override, else the global `ORG_STORAGE_QUOTA_BYTES`,
  // else null (unlimited) — resolved through the same `effectiveOrgStorageLimit`
  // the files service gates writes against.
  const storageQuota = getEnv().ORG_STORAGE_QUOTA_BYTES;
  const effectiveLimit = effectiveOrgStorageLimit(org.filesBytesLimit, storageQuota);

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.createdAt,
    storage: {
      used_bytes: org.filesBytesUsed,
      limit_bytes: org.filesBytesLimit ?? null,
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
      space_assignments: inv.spaceAssignments,
      token: inv.token,
      expiresAt: inv.expiresAt?.toISOString(),
      createdAt: inv.createdAt?.toISOString(),
    })),
  };
}

// GET /api/orgs/:orgId — org details + members
router.get("/:orgId", async (c) => {
  const orgId = c.req.param("orgId")!;

  // Membership, not RBAC: every org role reads its own org, and an API key
  // must keep working here. `orgRole` is the membership row both paths
  // already loaded — `resolveOrgPathPermissions` above for a session (it sets
  // the key only when the row exists), the auth pipeline for a key, whose
  // `validateApiKey` inner-joins the creator's live membership and whose org
  // is pinned to the path by `apiKeyOrgScopeGuard`. Re-querying would be a
  // second identical round-trip per request.
  if (!c.get("orgRole")) throw forbidden("Not a member of this organization");

  return c.json(await buildOrgDetail(orgId));
});

// PUT /api/orgs/:orgId — update name/slug (owner only — org routes skip org context)
router.put("/:orgId", requirePermission("org", "update"), async (c) => {
  const orgId = c.req.param("orgId")!;
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
router.delete("/:orgId", requirePermission("org", "delete"), async (c) => {
  const orgId = c.req.param("orgId")!;

  try {
    // Refuse FIRST, notify SECOND, delete THIRD — the order is load-bearing,
    // do not reorder.
    //
    // `onOrgDelete` handlers do destructive work outside this database and
    // outside any transaction we can roll back (the cloud module drains
    // billing then cancels the Stripe subscription and drops the billing
    // account; the mcp module drops the org from the RFC 8707 audience
    // allowlist). `deleteOrganization` refuses — from inside its transaction —
    // when runs are in progress. With the emit first, that refusal left a
    // surviving-but-gutted organization no repair path can rebuild. Asserting
    // deletability up front means modules only ever observe a deletion the
    // platform has already committed to.
    //
    // Both calls throw plain Errors, and both land on the same 400
    // `delete_failed` below — the wire contract is unchanged.
    await assertOrgDeletable(orgId);

    // Notify modules of org deletion (non-fatal — errors isolated per module, FK CASCADE handles cleanup)
    await emitEvent("onOrgDelete", orgId);

    await deleteOrganization(orgId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to delete organization";
    // This catch spans three calls and logs nothing — a `delete_failed` used
    // to produce ZERO log lines, so the only record was a message the client
    // got and the operator did not. `cause` puts it in the request-scoped log
    // (and carries any chain beneath it, which `msg` flattens away).
    throw new ApiError({
      status: 400,
      code: "delete_failed",
      title: "Bad Request",
      detail: msg,
      cause: err,
    });
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
router.post("/:orgId/members", requirePermission("members", "invite"), async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId")!;
  const data = await readJsonBody(c, addMemberSchema);
  const role = data.role;
  // Before the try: these are 400/404 refusals about the request, and the
  // catch below turns everything it wraps into a 500 `invitation_failed`.
  await assertSpaceAssignmentsValid({ orgId, role, assignments: data.space_assignments });

  try {
    const invitation = await createInvitation({
      email: data.email.trim(),
      orgId,
      role,
      invitedBy: user.id,
      spaceAssignments: data.space_assignments,
    });

    await recordAuditFromContext(c, {
      action: "org.invitation_created",
      resourceType: "invitation",
      resourceId: invitation.id,
      after: { email: invitation.email, role, space_assignments: invitation.spaceAssignments },
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
        space_assignments: invitation.spaceAssignments,
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
router.delete(
  "/:orgId/invitations/:invitationId",
  requirePermission("members", "invite"),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const invitationId = c.req.param("invitationId")!;

    await cancelInvitation(invitationId, orgId);
    await recordAuditFromContext(c, {
      action: "org.invitation_cancelled",
      resourceType: "invitation",
      resourceId: invitationId,
      orgIdOverride: orgId,
    });
    return c.body(null, 204);
  },
);

// PUT /api/orgs/:orgId/invitations/:invitationId — change invitation role (admin+)
router.put(
  "/:orgId/invitations/:invitationId",
  requirePermission("members", "change-role"),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const invitationId = c.req.param("invitationId")!;

    const data = await readJsonBody(c, updateInvitationSchema);

    const existing = await getPendingInvitation(invitationId, orgId);
    if (!existing) {
      throw notFound("Invitation not found or already accepted");
    }
    const spaceAssignments = data.space_assignments ?? existing.spaceAssignments;
    await assertSpaceAssignmentsValid({ orgId, role: data.role, assignments: spaceAssignments });

    const updated = await updateInvitation(invitationId, orgId, {
      role: data.role,
      spaceAssignments,
    });
    if (!updated) {
      throw notFound("Invitation not found or already accepted");
    }

    await recordAuditFromContext(c, {
      action: "org.invitation_role_updated",
      resourceType: "invitation",
      resourceId: invitationId,
      after: { role: data.role, space_assignments: spaceAssignments },
      orgIdOverride: orgId,
    });

    // Bare updated resource — same serializer as the invitations list in
    // GET /orgs/:orgId (issue #657).
    return c.json({
      id: updated.id,
      email: updated.email,
      role: updated.role,
      space_assignments: updated.spaceAssignments,
      token: updated.token,
      expiresAt: updated.expiresAt?.toISOString(),
      createdAt: updated.createdAt?.toISOString(),
    });
  },
);

// DELETE /api/orgs/:orgId/members/:userId — remove a member (admin+)
router.delete("/:orgId/members/:userId", requirePermission("members", "remove"), async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId")!;
  const targetUserId = c.req.param("userId")!;

  // Who-manages-whom runs after the guard, inside the handler: RBAC answers
  // "may this principal remove members at all", the policy answers "may it
  // remove THIS one".
  const actorRole = actingOrgRole(c);
  const target = await getOrgMember(orgId, targetUserId);
  if (!target) {
    throw notFound("Member not found");
  }
  if (
    !canRemoveMember({
      actorRole,
      targetRole: target.role,
      isSelf: targetUserId === user.id,
    })
  ) {
    throw forbidden("You cannot remove this member");
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

// PUT /api/orgs/:orgId/members/:userId — change role (owner/admin hierarchy)
router.put("/:orgId/members/:userId", requirePermission("members", "change-role"), async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId")!;
  const targetUserId = c.req.param("userId")!;

  const actorRole = actingOrgRole(c);
  const data = await readJsonBody(c, updateRoleSchema);

  const target = await getOrgMember(orgId, targetUserId);
  if (!target) {
    throw notFound("Member not found");
  }

  const assignableRoles = assignableRolesForMember({
    actorRole,
    targetRole: target.role,
    isSelf: targetUserId === user.id,
  });
  if (!assignableRoles.includes(data.role)) {
    throw forbidden("You cannot assign this role to this member");
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
  const orgId = c.req.param("orgId")!;

  // Membership gate — without it any cookie-session user could read an
  // arbitrary org's settings by passing its id (apiKeyOrgScopeGuard only
  // pins API keys, not sessions). Same already-loaded row as GET /:orgId.
  if (!c.get("orgRole")) throw forbidden("Not a member of this organization");

  const settings = await getOrgSettings(orgId);
  return c.json(settings);
});

// PUT /api/orgs/:orgId/settings — update org settings (owner/admin)
router.put("/:orgId/settings", requirePermission("org", "settings"), async (c) => {
  const orgId = c.req.param("orgId")!;
  const data = await readJsonBody(c, orgSettingsPatchSchema);

  // Write-side counterpart of the read-side check in `middleware/api-version.ts`.
  // That middleware is mounted on `*` and 400s on a pin it cannot serve, so
  // persisting an unsupported `api_version` breaks every org-scoped route until
  // the value is repaired. Whether the org can repair it itself depends on how
  // the caller authenticates, and the difference is what makes this guard
  // necessary rather than merely tidy:
  //
  //   - **Session (cookie) callers can always recover.** `skipOrgContext()`
  //     (`lib/auth-pipeline.ts`) returns true for `/api/orgs/`, so
  //     `requireOrgContext` never runs on this route and `c.get("orgId")` is
  //     unset — the middleware's org-pin branch is skipped entirely and the PUT
  //     answers 200. Reproduced against an org pinned to "2020-01-01" directly
  //     in the DB: `GET /api/runs` → 400, `PUT /api/orgs/:orgId/settings` → 200.
  //   - **API-key callers cannot.** `applyAuthPipeline` sets `orgId` inline from
  //     the key, before any path-based skip, so the pin branch runs on *every*
  //     route including this one. Same reproduction: `PUT` → 400. A headless
  //     operator with no dashboard session is locked out with no self-serve
  //     remedy.
  //
  // So the guard exists for the API-key caller, not for a universal self-DoS.
  // Rejecting on write keeps the unserveable state unreachable for both.
  //
  // The check lives here rather than as a `.refine()` on `orgSettingsSchema`:
  // that schema is exported from `@appstrate/core`, the published OSS package,
  // which must not learn the platform's version registry.
  if (data.api_version !== undefined && !isVersionSupported(data.api_version)) {
    throw unsupportedApiVersion(
      `API version "${data.api_version}" is not supported. Current version: ${CURRENT_API_VERSION}.`,
      "api_version",
    );
  }

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
