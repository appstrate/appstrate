// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import { ApiError, invalidRequest, internalError, parseBody } from "../lib/errors.ts";
import {
  createApplication,
  listApplications,
  getApplication,
  updateApplication,
  deleteApplication,
  appSettingsSchema,
} from "../services/applications.ts";
import {
  installPackage,
  uninstallPackage,
  listInstalledPackages,
  getInstalledPackage,
  updateInstalledPackage,
} from "../services/application-packages.ts";
import { validateDomainList } from "../services/redirect-validation.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { PackageType } from "@appstrate/core/validation";

const createApplicationSchema = z.object({
  name: z.string().min(1, "name is required").max(100, "name must be 100 characters or less"),
  settings: appSettingsSchema.optional(),
});

const updateApplicationSchema = z.object({
  name: z
    .string()
    .min(1, "name is required")
    .max(100, "name must be 100 characters or less")
    .optional(),
  settings: appSettingsSchema.optional(),
});

export function createApplicationsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/applications — list applications for the org
  router.get("/", async (c) => {
    const orgId = c.get("orgId");
    const apps = await listApplications(orgId);
    return c.json({
      object: "list",
      data: apps.map((app) => ({ object: "application", ...app })),
    });
  });

  // POST /api/applications — create a new application
  router.post("/", requirePermission("applications", "write"), async (c) => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const body = await c.req.json();
    const data = parseBody(createApplicationSchema, body);

    if (data.settings?.allowedRedirectDomains) {
      const validationError = validateDomainList(data.settings.allowedRedirectDomains);
      if (validationError) throw invalidRequest(validationError);
    }

    try {
      const app = await createApplication(orgId, data, user.id);
      return c.json({ object: "application", ...app }, 201);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Application creation failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }
  });

  // GET /api/applications/:id — get application detail
  router.get("/:id", async (c) => {
    const orgId = c.get("orgId");
    const appId = c.req.param("id");

    try {
      const app = await getApplication(orgId, appId);
      return c.json({ object: "application", ...app });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Failed to get application", {
        appId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }
  });

  // PATCH /api/applications/:id — update application
  router.patch("/:id", requirePermission("applications", "write"), async (c) => {
    const orgId = c.get("orgId");
    const appId = c.req.param("id")!;
    const body = await c.req.json();
    const data = parseBody(updateApplicationSchema, body);

    if (data.settings?.allowedRedirectDomains) {
      const validationError = validateDomainList(data.settings.allowedRedirectDomains);
      if (validationError) throw invalidRequest(validationError);
    }

    try {
      const app = await updateApplication(orgId, appId, data);
      return c.json({ object: "application", ...app });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Application update failed", {
        appId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }
  });

  // DELETE /api/applications/:id — delete application
  router.delete("/:id", requirePermission("applications", "delete"), async (c) => {
    const orgId = c.get("orgId");
    const appId = c.req.param("id")!;

    try {
      await deleteApplication(orgId, appId);
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Application deletion failed", {
        appId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }
  });

  // ─── Application Packages (install/uninstall/config) ─────────────────────

  const installPackageSchema = z.object({
    packageId: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
  });

  const updatePackageSchema = z.object({
    config: z.record(z.string(), z.unknown()).optional(),
    modelId: z.string().nullable().optional(),
    proxyId: z.string().nullable().optional(),
    orgProfileId: z.string().nullable().optional(),
    versionId: z.number().int().nullable().optional(),
    enabled: z.boolean().optional(),
  });

  // GET /api/applications/:appId/packages — list installed packages
  router.get("/:appId/packages", async (c) => {
    const orgId = c.get("orgId");
    const appId = c.req.param("appId")!;
    await getApplication(orgId, appId);

    const type = c.req.query("type") as PackageType | undefined;
    const rows = await listInstalledPackages(appId, type);
    return c.json({
      object: "list",
      data: rows.map((row) => ({ object: "application_package", ...row })),
    });
  });

  // POST /api/applications/:appId/packages — install a package
  router.post("/:appId/packages", requirePermission("applications", "write"), async (c) => {
    const orgId = c.get("orgId");
    const appId = c.req.param("appId")!;
    await getApplication(orgId, appId);

    const body = await c.req.json();
    const data = parseBody(installPackageSchema, body);

    const row = await installPackage(appId, orgId, data.packageId, data.config);
    return c.json({ object: "application_package", ...row }, 201);
  });

  // GET /api/applications/:appId/packages/:packageId — get installed package detail
  router.get("/:appId/packages/:scope{@[^/]+}/:name", async (c) => {
    const orgId = c.get("orgId");
    const appId = c.req.param("appId")!;
    await getApplication(orgId, appId);

    const packageId = `${c.req.param("scope")!}/${c.req.param("name")!}`;
    const row = await getInstalledPackage(appId, packageId);
    if (!row) {
      throw new ApiError({
        status: 404,
        code: "package_not_installed",
        title: "Package Not Installed",
        detail: `Package '${packageId}' is not installed in this application`,
      });
    }
    return c.json({ object: "application_package", ...row });
  });

  // PUT /api/applications/:appId/packages/:packageId — update config
  router.put(
    "/:appId/packages/:scope{@[^/]+}/:name",
    requirePermission("applications", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const appId = c.req.param("appId")!;
      await getApplication(orgId, appId);

      const packageId = `${c.req.param("scope")!}/${c.req.param("name")!}`;
      const body = await c.req.json();
      const data = parseBody(updatePackageSchema, body);

      await updateInstalledPackage(appId, packageId, data);
      const updated = await getInstalledPackage(appId, packageId);
      return c.json({ object: "application_package", ...updated });
    },
  );

  // DELETE /api/applications/:appId/packages/:packageId — uninstall
  router.delete(
    "/:appId/packages/:scope{@[^/]+}/:name",
    requirePermission("applications", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const appId = c.req.param("appId")!;
      await getApplication(orgId, appId);

      const packageId = `${c.req.param("scope")!}/${c.req.param("name")!}`;
      await uninstallPackage(appId, packageId);
      return c.body(null, 204);
    },
  );

  return router;
}
