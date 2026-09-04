// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { Context, Next } from "hono";
import { z } from "zod";
import { SPACE_ROLE_PRESETS, SPACE_VISIBILITIES } from "@appstrate/core/permissions";
import type { SpaceRolePreset, SpaceVisibility } from "@appstrate/core/permissions";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizationMembers } from "@appstrate/db/schema";
import {
  modelGenerationSettingsSchema,
  reconcileModelGenerationSettings,
} from "@appstrate/core/model-generation";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import { apiKeySpaceScopeGuard } from "../middleware/guards.ts";
import { ApiError, forbidden, invalidRequest, internalError, notFound } from "../lib/errors.ts";
import { readJsonBody } from "../lib/request-body.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { listResponse } from "../lib/list-response.ts";
import {
  createSpace,
  isSpaceVisibleTo,
  listSpacesForPrincipal,
  getSpace,
  updateSpace,
  deleteSpace,
  spaceSettingsSchema,
} from "../services/spaces.ts";
import {
  listSpaceMembers,
  removeSpaceMember,
  upsertSpaceMember,
  type SpaceRoleAssignment,
} from "../services/space-members.ts";
import {
  assertOrgRole,
  effectivePermissions,
  orgPermissions as orgPermissionsFor,
} from "../lib/permissions.ts";
import {
  loadSpaceMember,
  resolveSpaceRole,
  spacePermissions,
  toSpaceRoleWire,
  type SpaceRoleRef,
} from "../lib/space-role.ts";
import { applySpacePermissions, validateSpaceInOrg } from "../middleware/space-context.ts";
import {
  installPackage,
  uninstallPackage,
  listInstalledPackages,
  getInstalledPackage,
  updateInstalledPackage,
  getResolvedRunConfig,
} from "../services/space-packages.ts";
import { validateDomainList } from "../services/redirect-validation.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { PackageType } from "@appstrate/core/validation";
import { recordAuditFromContext } from "../services/audit.ts";
import { SCOPED_PACKAGE_ROUTE } from "./scoped-package-route.ts";
import {
  assertExplicitModelExists,
  resolveModel,
  validateGenerationOverride,
} from "../services/org-models.ts";

/**
 * Project a Drizzle space row onto the wire shape. The DB column is
 * `created_by` (snake_case) but the Drizzle TS field is `createdBy`; the wire
 * contract (SpaceObject) is snake_case `created_by`, so rename here.
 */
/**
 * The wire shape every space response carries: the row plus the CALLER's
 * standing in it. `SpaceObject` requires all five, so a route that returned
 * only the row would answer a body its own contract refuses.
 */
function spaceWireForCaller(
  c: Context<AppEnv>,
  space: {
    id: string;
    createdBy: string | null;
    visibility: SpaceVisibility;
    defaultRole: SpaceRolePreset;
  },
  role: SpaceRoleRef | null,
) {
  return {
    object: "space" as const,
    ...toSpaceWire(space),
    access: role ? ("member" as const) : ("none" as const),
    role: toSpaceRoleWire(role),
    permissions: [
      ...effectivePermissions({
        orgPermissions: c.get("orgPermissions") ?? orgPermissionsFor(c.get("orgRole")),
        spacePermissions: spacePermissions(role),
        scopeCeiling: c.get("scopeCeiling"),
      }),
    ].sort(),
  };
}

/** Narrow a validated member body to the service's assignment shape. */
function toAssignment(data: {
  preset_role?: SpaceRolePreset;
  custom_role_id?: string;
}): SpaceRoleAssignment {
  return data.preset_role !== undefined
    ? { preset_role: data.preset_role }
    : { custom_role_id: data.custom_role_id! };
}

/**
 * Project a Drizzle space row onto the wire shape. The DB columns are
 * `created_by` / `default_role`; the Drizzle TS fields are `createdBy` /
 * `defaultRole` and the wire contract (SpaceObject) is snake_case for both, so
 * both are renamed here.
 */
function toSpaceWire<T extends { createdBy: string | null; defaultRole: SpaceRolePreset }>(
  space: T,
): Omit<T, "createdBy" | "defaultRole"> & {
  created_by: string | null;
  default_role: SpaceRolePreset;
} {
  const { createdBy, defaultRole, ...rest } = space;
  return { ...rest, created_by: createdBy, default_role: defaultRole };
}

export const createSpaceSchema = z
  .object({
    name: z.string().min(1, "name is required").max(100, "name must be 100 characters or less"),
    settings: spaceSettingsSchema.optional(),
  })
  .strict();

export const updateSpaceSchema = z
  .object({
    name: z
      .string()
      .min(1, "name is required")
      .max(100, "name must be 100 characters or less")
      .optional(),
    settings: spaceSettingsSchema.optional(),
    visibility: z.enum(SPACE_VISIBILITIES).optional(),
    default_role: z.enum(SPACE_ROLE_PRESETS).optional(),
  })
  .strict();

/** `{ user_id, preset_role }` or `{ user_id, custom_role_id }` — never both. */
export const addSpaceMemberSchema = z
  .object({
    userId: z.string().min(1),
    preset_role: z.enum(SPACE_ROLE_PRESETS).optional(),
    custom_role_id: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => (v.preset_role === undefined) !== (v.custom_role_id === undefined), {
    message: "exactly one of preset_role or custom_role_id is required",
  });

export const updateSpaceMemberSchema = z
  .object({
    preset_role: z.enum(SPACE_ROLE_PRESETS).optional(),
    custom_role_id: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => (v.preset_role === undefined) !== (v.custom_role_id === undefined), {
    message: "exactly one of preset_role or custom_role_id is required",
  });

// Neither body carries the agent's stored input values: `PUT
// /api/agents/{scope}/{name}/input-settings` is their single write path,
// because it is the only one that validates them against
// `manifest.input.schema` and enforces `assertLockedFieldsSatisfiable`.
export const installPackageSchema = z
  .object({
    packageId: z.string().min(1),
  })
  .strict();

export const updatePackageSchema = z
  .object({
    generationConfig: modelGenerationSettingsSchema.nullable().optional(),
    modelId: z.string().nullable().optional(),
    proxyId: z.string().nullable().optional(),
    version_id: z.number().int().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/**
 * Resolve the space named by a path param and apply the caller's permissions in
 * it, so a space-level guard downstream reads the right Set.
 *
 * `/api/spaces` is deliberately NOT in `SPACE_SCOPED_PREFIXES` — it is the
 * catalog route family, and its own listing must stay reachable without one
 * space being current. The per-space routes therefore resolve their space here
 * instead, through the same helper the middleware uses (spec §4.3).
 */
function requireSpaceFromParam(param: "id" | "spaceId") {
  return async (c: Context<AppEnv>, next: Next) => {
    const spaceId = c.req.param(param)!;
    const space = await validateSpaceInOrg(spaceId, c.get("orgId"));
    if (!space) throw notFound(`Space '${spaceId}' not found in this organization`);
    await applySpacePermissions(c, space);
    c.set("space", space);
    return next();
  };
}

export function createSpacesRouter() {
  const router = new Hono<AppEnv>();

  router.use("/:id", apiKeySpaceScopeGuard);
  router.use("/:spaceId/*", apiKeySpaceScopeGuard);

  // GET /api/spaces — list spaces the caller reaches (RBAC spec §6.3)
  router.get("/", requirePermission("spaces", "read"), async (c) => {
    const orgId = c.get("orgId");
    const orgRole = c.get("orgRole");
    const entries = await listSpacesForPrincipal(orgId, orgRole, c.get("user").id);
    // An API key never enumerates its siblings: it sees the one space it is
    // bound to, whatever its creator reaches.
    const keySpaceId = c.get("spaceId");
    const scoped =
      c.get("authMethod") === "api_key"
        ? entries.filter((e) => e.space.id === keySpaceId)
        : entries;
    return c.json(
      listResponse(scoped.map(({ space, role }) => spaceWireForCaller(c, space, role))),
    );
  });

  // POST /api/spaces — create a new space
  router.post("/", requirePermission("spaces", "write"), async (c) => {
    if (c.get("authMethod") === "api_key") {
      throw forbidden("API keys cannot create spaces");
    }
    const orgId = c.get("orgId");
    const user = c.get("user");
    const data = await readJsonBody(c, createSpaceSchema);

    if (data.settings?.allowedRedirectDomains) {
      const validationError = validateDomainList(data.settings.allowedRedirectDomains);
      if (validationError) throw invalidRequest(validationError);
    }

    try {
      const space = await createSpace(orgId, data, user.id);
      await recordAuditFromContext(c, {
        action: "space.created",
        resourceType: "space",
        resourceId: space.id,
        after: { name: space.name },
      });
      // The creator holds org-level `spaces:write`, i.e. owner or admin, so
      // the resolver answers preset `admin` without any row — and no row is
      // written, per RBAC spec §6.3.
      const role = resolveSpaceRole(c.get("orgRole"), space, null);
      return c.json(spaceWireForCaller(c, space, role), 201);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Space creation failed", {
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // GET /api/spaces/:id — get space detail. Visible exactly when it would
  // appear in this caller's listing (`isSpaceVisibleTo`, the same predicate);
  // hidden means 404, not 403 — the space does not exist for them.
  router.get("/:id", requirePermission("spaces", "read"), async (c) => {
    const orgId = c.get("orgId");
    const spaceId = c.req.param("id")!;

    try {
      const space = await getSpace(orgId, spaceId);
      const orgRole = c.get("orgRole");
      // One PK lookup, not the whole membership set: a single-space read has
      // exactly one row to find.
      const role = resolveSpaceRole(
        orgRole,
        space,
        await loadSpaceMember(space.id, c.get("user").id),
      );
      if (!isSpaceVisibleTo(orgRole, space, role)) {
        throw notFound(`Space '${spaceId}' not found in this organization`);
      }
      return c.json(spaceWireForCaller(c, space, role));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Failed to get space", {
        spaceId,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // PATCH /api/spaces/:id — update space. `space-settings:write` (preset admin),
  // resolved from the PATH space, not from `X-Space-Id`.
  router.patch(
    "/:id",
    requireSpaceFromParam("id"),
    requirePermission("space-settings", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const spaceId = c.req.param("id")!;
      const data = await readJsonBody(c, updateSpaceSchema);

      if (data.settings?.allowedRedirectDomains) {
        const validationError = validateDomainList(data.settings.allowedRedirectDomains);
        if (validationError) throw invalidRequest(validationError);
      }

      try {
        const { default_role, ...rest } = data;
        const space = await updateSpace(orgId, spaceId, { ...rest, defaultRole: default_role });
        await recordAuditFromContext(c, {
          action: "space.updated",
          resourceType: "space",
          resourceId: space.id,
          after: data as unknown as Record<string, unknown>,
        });
        return c.json(spaceWireForCaller(c, space, c.get("spaceRole") ?? null));
      } catch (err) {
        if (err instanceof ApiError) throw err;
        logger.error("Space update failed", {
          spaceId,
          error: getErrorMessage(err),
        });
        throw internalError();
      }
    },
  );

  // DELETE /api/spaces/:id — delete space
  router.delete("/:id", requirePermission("spaces", "delete"), async (c) => {
    const orgId = c.get("orgId");
    const spaceId = c.req.param("id")!;

    try {
      await deleteSpace(orgId, spaceId);
      await recordAuditFromContext(c, {
        action: "space.deleted",
        resourceType: "space",
        resourceId: spaceId,
      });
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Space deletion failed", {
        spaceId,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // ─── Space members (RBAC spec §6.4) ────────────────────────────────

  // Every member route resolves the PATH space first, so `space-members:*`
  // (preset `admin`) is read from the caller's set in THAT space.
  router.use("/:id/members", requireSpaceFromParam("id"));
  router.use("/:id/members/*", requireSpaceFromParam("id"));

  // GET /api/spaces/:id/members — who actually has access, not who was added
  router.get("/:id/members", requirePermission("space-members", "read"), async (c) => {
    const space = c.get("space")!;
    return c.json(listResponse(await listSpaceMembers(c.get("orgId"), space)));
  });

  // POST /api/spaces/:id/members — grant an explicit role
  router.post("/:id/members", requirePermission("space-members", "invite"), async (c) => {
    const orgId = c.get("orgId");
    const spaceId = c.req.param("id")!;
    const data = await readJsonBody(c, addSpaceMemberSchema);
    const assignment = toAssignment(data);

    await upsertSpaceMember({
      orgId,
      spaceId,
      userId: data.userId,
      assignment,
      addedBy: c.get("user").id,
    });
    await recordAuditFromContext(c, {
      action: "space.member_added",
      resourceType: "space_member",
      resourceId: `${spaceId}:${data.userId}`,
      after: assignment as unknown as Record<string, unknown>,
    });
    return c.json({ object: "space_member", userId: data.userId, ...assignment }, 201);
  });

  // PATCH /api/spaces/:id/members/:userId — change an existing explicit role
  router.patch(
    "/:id/members/:userId",
    requirePermission("space-members", "change-role"),
    async (c) => {
      const orgId = c.get("orgId");
      const spaceId = c.req.param("id")!;
      const userId = c.req.param("userId")!;
      const data = await readJsonBody(c, updateSpaceMemberSchema);
      const assignment = toAssignment(data);

      await upsertSpaceMember({
        orgId,
        spaceId,
        userId,
        assignment,
        addedBy: c.get("user").id,
        requireExisting: true,
      });
      await recordAuditFromContext(c, {
        action: "space.member_role_changed",
        resourceType: "space_member",
        resourceId: `${spaceId}:${userId}`,
        after: assignment as unknown as Record<string, unknown>,
      });
      return c.json({ object: "space_member", userId, ...assignment });
    },
  );

  // DELETE /api/spaces/:id/members/:userId — drop the explicit role.
  // `access_after` says whether that ends their access or drops them back to
  // the open space's implicit membership; the caller should not have to
  // re-derive it from the visibility.
  router.delete("/:id/members/:userId", requirePermission("space-members", "remove"), async (c) => {
    const orgId = c.get("orgId");
    const space = c.get("space")!;
    const userId = c.req.param("userId")!;

    if (!(await removeSpaceMember(space.id, userId))) {
      throw notFound("Space member not found");
    }
    await recordAuditFromContext(c, {
      action: "space.member_removed",
      resourceType: "space_member",
      resourceId: `${space.id}:${userId}`,
    });

    // What is left after the row is gone — one PK lookup, one membership row.
    // The row was just deleted, so this can only find one an admin re-added
    // concurrently; the org role is what usually answers.
    const [member] = await db
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .limit(1);
    const after = member
      ? resolveSpaceRole(assertOrgRole(member.role), space, await loadSpaceMember(space.id, userId))
      : null;
    return c.json({ access_after: after ? "implicit" : "none" });
  });

  // ─── Space Packages (install/uninstall/config) ─────────────────────

  // Guard: resolve the PATH space and the caller's role in it, once for all
  // /:spaceId/packages/* routes. These are space-scoped by their path, not by
  // `X-Space-Id`, so they resolve their own space — `run-config` gates on
  // `agents:read`, a space-level string that org context alone never carries.
  router.use("/:spaceId/packages/*", requireSpaceFromParam("spaceId"));
  router.use("/:spaceId/packages", requireSpaceFromParam("spaceId"));

  // GET /api/spaces/:spaceId/packages — list installed packages.
  // The `router.use` guards above only prove the space belongs to the org;
  // `spaces:read` is the read twin of the `spaces:write` the mutating routes
  // carry, and matches this route being package-type agnostic.
  router.get("/:spaceId/packages", requirePermission("spaces", "read"), async (c) => {
    const spaceId = c.req.param("spaceId")!;
    const orgId = c.get("orgId");
    const type = c.req.query("type") as PackageType | undefined;
    const rows = await listInstalledPackages({ orgId, spaceId: spaceId }, type);
    return c.json(listResponse(rows.map((row) => ({ object: "space_package", ...row }))));
  });

  // POST /api/spaces/:spaceId/packages — install a package
  router.post("/:spaceId/packages", requirePermission("spaces", "write"), async (c) => {
    const orgId = c.get("orgId");
    const spaceId = c.req.param("spaceId")!;

    const data = await readJsonBody(c, installPackageSchema);

    await installPackage({ orgId, spaceId: spaceId }, data.packageId);
    const row = await getInstalledPackage({ orgId, spaceId: spaceId }, data.packageId);
    return c.json({ object: "space_package", ...row }, 201);
  });

  // GET /api/spaces/:spaceId/packages/:packageId — get installed package detail
  router.get(
    `/:spaceId/packages/${SCOPED_PACKAGE_ROUTE}`,
    requirePermission("spaces", "read"),
    async (c) => {
      const spaceId = c.req.param("spaceId")!;
      const orgId = c.get("orgId");
      const packageId = `${c.req.param("scope")!}/${c.req.param("name")!}`;
      const row = await getInstalledPackage({ orgId, spaceId: spaceId }, packageId);
      if (!row) {
        throw new ApiError({
          status: 404,
          code: "package_not_installed",
          title: "Package Not Installed",
          detail: `Package '${packageId}' is not installed in this space`,
        });
      }
      return c.json({ object: "space_package", ...row });
    },
  );

  // PUT /api/spaces/:spaceId/packages/:packageId — update config
  router.put(
    `/:spaceId/packages/${SCOPED_PACKAGE_ROUTE}`,
    requirePermission("spaces", "write"),
    async (c) => {
      const spaceId = c.req.param("spaceId")!;
      const orgId = c.get("orgId");
      const scope = { orgId, spaceId: spaceId };
      const packageId = `${c.req.param("scope")!}/${c.req.param("name")!}`;
      const data = await readJsonBody(c, updatePackageSchema);

      const installed = await getInstalledPackage(scope, packageId);
      let generationConfig = data.generationConfig;
      if (installed && (data.modelId !== undefined || generationConfig !== undefined)) {
        const effectiveModelId = data.modelId !== undefined ? data.modelId : installed.modelId;
        const explicitModel =
          data.modelId !== undefined ? await assertExplicitModelExists(orgId, data.modelId) : null;
        const selectedModel =
          explicitModel ?? (await resolveModel(orgId, packageId, effectiveModelId));

        if (generationConfig && Object.keys(generationConfig).length > 0) {
          generationConfig = validateGenerationOverride(
            generationConfig,
            selectedModel,
            "generationConfig",
          );
        } else if (
          generationConfig === undefined &&
          data.modelId !== undefined &&
          installed.generationConfig
        ) {
          // Reconcile only when `modelId` is part of THIS patch: re-clamping
          // stored settings is a response to the selected model possibly
          // having changed, and a patch that never mentions `modelId` cannot
          // change it. Without the conjunct a `{ enabled: false }` patch would
          // silently rewrite `generation_config` on a request that never named
          // it.
          generationConfig = reconcileModelGenerationSettings(
            installed.generationConfig,
            selectedModel?.generation,
          );
        }
      }

      const { version_id, generationConfig: _generationConfig, ...rest } = data;
      void _generationConfig;
      // `requireInstalled` — this route updates an EXISTING association; a
      // packageId that is not installed (or not visible to the org) is a 404,
      // never an implicit install via upsert.
      await updateInstalledPackage(
        scope,
        packageId,
        {
          ...rest,
          ...(generationConfig !== undefined ? { generationConfig } : {}),
          versionId: version_id,
        },
        { requireInstalled: true },
      );
      const updated = await getInstalledPackage(scope, packageId);
      return c.json({ object: "space_package", ...updated });
    },
  );

  // DELETE /api/spaces/:spaceId/packages/:packageId — uninstall
  router.delete(
    `/:spaceId/packages/${SCOPED_PACKAGE_ROUTE}`,
    requirePermission("spaces", "write"),
    async (c) => {
      const spaceId = c.req.param("spaceId")!;
      const orgId = c.get("orgId");
      const packageId = `${c.req.param("scope")!}/${c.req.param("name")!}`;
      await uninstallPackage({ orgId, spaceId: spaceId }, packageId);
      return c.body(null, 204);
    },
  );

  // GET /api/spaces/:spaceId/packages/:scope/:name/run-config —
  // single source of truth for the per-space config, model/proxy override,
  // and version pin. Consumed by the CLI to reproduce a UI run without
  // hand-stitching three separate calls.
  router.get(
    `/:spaceId/packages/${SCOPED_PACKAGE_ROUTE}/run-config`,
    requirePermission("agents", "read"),
    async (c) => {
      const spaceId = c.req.param("spaceId")!;
      const orgId = c.get("orgId");
      const packageId = `${c.req.param("scope")!}/${c.req.param("name")!}`;
      const resolved = await getResolvedRunConfig({ orgId, spaceId }, packageId);
      if (!resolved) {
        throw new ApiError({
          status: 404,
          code: "package_not_installed",
          title: "Package Not Installed",
          detail: `Package '${packageId}' is not installed in this space`,
        });
      }
      return c.json(resolved);
    },
  );

  return router;
}
