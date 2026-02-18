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
      createdAt: o.created_at,
    })),
  });
});

// POST /api/orgs — create an organization (no org context needed)
router.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ name: string; slug?: string }>();

  if (!body.name?.trim()) {
    return c.json({ error: "VALIDATION_ERROR", message: "Le nom est requis" }, 400);
  }

  const slug = body.slug?.trim() || slugify(body.name);
  if (!slug || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    return c.json(
      { error: "VALIDATION_ERROR", message: "Le slug est invalide (kebab-case requis)" },
      400,
    );
  }

  if (!(await isSlugAvailable(slug))) {
    return c.json({ error: "SLUG_TAKEN", message: `Le slug '${slug}' est deja utilise` }, 400);
  }

  const org = await createOrganization(body.name.trim(), slug, user.id);

  return c.json(
    {
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: "owner",
      createdAt: org.created_at,
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
    return c.json({ error: "FORBIDDEN", message: "Non membre de cette organisation" }, 403);
  }

  const [org, members] = await Promise.all([getOrgById(orgId), getOrgMembers(orgId)]);
  if (!org) {
    return c.json({ error: "NOT_FOUND", message: "Organisation introuvable" }, 404);
  }

  return c.json({
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.created_at,
    members: members.map((m) => ({
      userId: m.user_id,
      role: m.role,
      joinedAt: m.joined_at,
      displayName: m.display_name,
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
      { error: "FORBIDDEN", message: "Seul le proprietaire peut modifier l'organisation" },
      403,
    );
  }

  const body = await c.req.json<{ name?: string; slug?: string }>();

  if (body.slug) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(body.slug)) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "Le slug est invalide (kebab-case requis)" },
        400,
      );
    }
    if (!(await isSlugAvailable(body.slug))) {
      return c.json(
        { error: "SLUG_TAKEN", message: `Le slug '${body.slug}' est deja utilise` },
        400,
      );
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
      { error: "FORBIDDEN", message: "Seul le proprietaire peut supprimer l'organisation" },
      403,
    );
  }

  try {
    await deleteOrganization(orgId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erreur lors de la suppression";
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
    return c.json(
      { error: "FORBIDDEN", message: "Seuls les admins peuvent ajouter des membres" },
      403,
    );
  }

  const body = await c.req.json<{ email: string; role?: string }>();
  if (!body.email?.trim()) {
    return c.json({ error: "VALIDATION_ERROR", message: "L'email est requis" }, 400);
  }

  const role = (body.role as "member" | "admin") || "member";
  if (!["member", "admin"].includes(role)) {
    return c.json(
      { error: "VALIDATION_ERROR", message: "Le role doit etre 'member' ou 'admin'" },
      400,
    );
  }

  const targetUser = await findUserByEmail(body.email.trim());
  if (!targetUser) {
    return c.json({ error: "USER_NOT_FOUND", message: "Aucun utilisateur avec cet email" }, 404);
  }

  try {
    await addMember(orgId, targetUser.id, role);
  } catch (err) {
    return c.json(
      {
        error: "ADD_MEMBER_FAILED",
        message: err instanceof Error ? err.message : "Impossible d'ajouter le membre",
      },
      400,
    );
  }

  return c.json({ userId: targetUser.id, role }, 201);
});

// DELETE /api/orgs/:orgId/members/:userId — remove a member (admin/owner only)
router.delete("/:orgId/members/:userId", async (c) => {
  const user = c.get("user");
  const orgId = c.req.param("orgId");
  const targetUserId = c.req.param("userId");

  const member = await getOrgMember(orgId, user.id);
  if (!member || !["owner", "admin"].includes(member.role)) {
    return c.json(
      { error: "FORBIDDEN", message: "Seuls les admins peuvent retirer des membres" },
      403,
    );
  }

  // Cannot remove the owner
  const target = await getOrgMember(orgId, targetUserId);
  if (!target) {
    return c.json({ error: "NOT_FOUND", message: "Membre introuvable" }, 404);
  }
  if (target.role === "owner") {
    return c.json({ error: "FORBIDDEN", message: "Impossible de retirer le proprietaire" }, 403);
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
    return c.json(
      { error: "FORBIDDEN", message: "Seul le proprietaire peut changer les roles" },
      403,
    );
  }

  const body = await c.req.json<{ role: string }>();
  if (!["member", "admin"].includes(body.role)) {
    return c.json(
      { error: "VALIDATION_ERROR", message: "Le role doit etre 'member' ou 'admin'" },
      400,
    );
  }

  // Cannot change own role
  if (targetUserId === user.id) {
    return c.json({ error: "FORBIDDEN", message: "Impossible de changer votre propre role" }, 400);
  }

  await updateMemberRole(orgId, targetUserId, body.role as "member" | "admin");
  return c.json({ userId: targetUserId, role: body.role });
});

export default router;
