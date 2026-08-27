// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import {
  ModelGenerationError,
  modelGenerationSettingsSchema,
  reconcileModelGenerationSettings,
  resolveModelGenerationSettings,
} from "@appstrate/core/model-generation";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import { apiKeySpaceScopeGuard } from "../middleware/guards.ts";
import { ApiError, forbidden, invalidRequest, internalError } from "../lib/errors.ts";
import { readJsonBody } from "../lib/request-body.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { listResponse } from "../lib/list-response.ts";
import {
  createSpace,
  listSpaces,
  getSpace,
  updateSpace,
  deleteSpace,
  spaceSettingsSchema,
} from "../services/spaces.ts";
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
import { assertExplicitModelExists, resolveModel } from "../services/org-models.ts";

/**
 * Project a Drizzle space row onto the wire shape. The DB column is
 * `created_by` (snake_case) but the Drizzle TS field is `createdBy`; the wire
 * contract (SpaceObject) is snake_case `created_by`, so rename here.
 */
function toSpaceWire<T extends { createdBy: string | null }>(
  space: T,
): Omit<T, "createdBy"> & { created_by: string | null } {
  const { createdBy, ...rest } = space;
  return { ...rest, created_by: createdBy };
}

export const createSpaceSchema = z.object({
  name: z.string().min(1, "name is required").max(100, "name must be 100 characters or less"),
  settings: spaceSettingsSchema.optional(),
});

export const updateSpaceSchema = z.object({
  name: z
    .string()
    .min(1, "name is required")
    .max(100, "name must be 100 characters or less")
    .optional(),
  settings: spaceSettingsSchema.optional(),
});

// Neither body carries the agent's stored input values: `PUT
// /api/agents/{scope}/{name}/input-settings` is their single write path,
// because it is the only one that validates them against
// `manifest.input.schema` and enforces `assertLockedFieldsSatisfiable`.
export const installPackageSchema = z.object({
  packageId: z.string().min(1),
});

export const updatePackageSchema = z.object({
  generationConfig: modelGenerationSettingsSchema.nullable().optional(),
  modelId: z.string().nullable().optional(),
  proxyId: z.string().nullable().optional(),
  version_id: z.number().int().nullable().optional(),
  enabled: z.boolean().optional(),
});

export function createSpacesRouter() {
  const router = new Hono<AppEnv>();

  router.use("/:id", apiKeySpaceScopeGuard);
  router.use("/:spaceId/*", apiKeySpaceScopeGuard);

  // GET /api/spaces — list spaces for the org
  router.get("/", requirePermission("spaces", "read"), async (c) => {
    const orgId = c.get("orgId");
    const spaces = await listSpaces(orgId);
    const authMethod = c.get("authMethod");
    const keySpaceId = c.get("spaceId");
    const scoped = authMethod === "api_key" ? spaces.filter((a) => a.id === keySpaceId) : spaces;
    return c.json(
      listResponse(scoped.map((space) => ({ object: "space", ...toSpaceWire(space) }))),
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
      return c.json({ object: "space", ...toSpaceWire(space) }, 201);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Space creation failed", {
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // GET /api/spaces/:id — get space detail
  router.get("/:id", requirePermission("spaces", "read"), async (c) => {
    const orgId = c.get("orgId");
    const spaceId = c.req.param("id")!;

    try {
      const space = await getSpace(orgId, spaceId);
      return c.json({ object: "space", ...toSpaceWire(space) });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Failed to get space", {
        spaceId,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // PATCH /api/spaces/:id — update space
  router.patch("/:id", requirePermission("spaces", "write"), async (c) => {
    const orgId = c.get("orgId");
    const spaceId = c.req.param("id")!;
    const data = await readJsonBody(c, updateSpaceSchema);

    if (data.settings?.allowedRedirectDomains) {
      const validationError = validateDomainList(data.settings.allowedRedirectDomains);
      if (validationError) throw invalidRequest(validationError);
    }

    try {
      const space = await updateSpace(orgId, spaceId, data);
      await recordAuditFromContext(c, {
        action: "space.updated",
        resourceType: "space",
        resourceId: space.id,
        after: data as unknown as Record<string, unknown>,
      });
      return c.json({ object: "space", ...toSpaceWire(space) });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Space update failed", {
        spaceId,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

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

  // ─── Space Packages (install/uninstall/config) ─────────────────────

  // Guard: validate that the space belongs to the org (once for all /:spaceId/packages/* routes)
  router.use("/:spaceId/packages/*", async (c, next) => {
    await getSpace(c.get("orgId"), c.req.param("spaceId")!);
    return next();
  });
  router.use("/:spaceId/packages", async (c, next) => {
    await getSpace(c.get("orgId"), c.req.param("spaceId")!);
    return next();
  });

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
          if (!selectedModel) {
            throw invalidRequest(
              "A model must be configured before generation settings can be saved",
            );
          }
          try {
            generationConfig = resolveModelGenerationSettings({
              capabilities: selectedModel.generation,
              override: generationConfig,
            });
          } catch (error) {
            if (error instanceof ModelGenerationError) {
              throw invalidRequest(error.message, "generationConfig");
            }
            throw error;
          }
        } else if (
          generationConfig === undefined &&
          data.modelId !== undefined &&
          installed.generationConfig
        ) {
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
