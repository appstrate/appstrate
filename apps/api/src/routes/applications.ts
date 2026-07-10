// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import { apiKeyAppScopeGuard } from "../middleware/guards.ts";
import { ApiError, forbidden, invalidRequest, internalError } from "../lib/errors.ts";
import { readJsonBody } from "../lib/request-body.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { listResponse } from "../lib/list-response.ts";
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
  getResolvedRunConfig,
} from "../services/application-packages.ts";
import { validateDomainList } from "../services/redirect-validation.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { PackageType } from "@appstrate/core/validation";
import { recordAuditFromContext } from "../services/audit.ts";
import { SCOPED_PACKAGE_ROUTE } from "./scoped-package-route.ts";

/**
 * Project a Drizzle application row onto the wire shape. The DB column is
 * `created_by` (snake_case) but the Drizzle TS field is `createdBy`; the wire
 * contract (ApplicationObject) is snake_case `created_by`, so rename here.
 */
function toApplicationWire<T extends { createdBy: string | null }>(
  app: T,
): Omit<T, "createdBy"> & { created_by: string | null } {
  const { createdBy, ...rest } = app;
  return { ...rest, created_by: createdBy };
}

export const createApplicationSchema = z.object({
  name: z.string().min(1, "name is required").max(100, "name must be 100 characters or less"),
  settings: appSettingsSchema.optional(),
});

export const updateApplicationSchema = z.object({
  name: z
    .string()
    .min(1, "name is required")
    .max(100, "name must be 100 characters or less")
    .optional(),
  settings: appSettingsSchema.optional(),
});

export const installPackageSchema = z.object({
  packageId: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const updatePackageSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  modelId: z.string().nullable().optional(),
  proxyId: z.string().nullable().optional(),
  version_id: z.number().int().nullable().optional(),
  enabled: z.boolean().optional(),
});

export function createApplicationsRouter() {
  const router = new Hono<AppEnv>();

  router.use("/:id", apiKeyAppScopeGuard);
  router.use("/:applicationId/*", apiKeyAppScopeGuard);

  // GET /api/applications — list applications for the org
  router.get("/", requirePermission("applications", "read"), async (c) => {
    const orgId = c.get("orgId");
    const apps = await listApplications(orgId);
    const authMethod = c.get("authMethod");
    const keyAppId = c.get("applicationId");
    const scoped = authMethod === "api_key" ? apps.filter((a) => a.id === keyAppId) : apps;
    return c.json(
      listResponse(scoped.map((app) => ({ object: "application", ...toApplicationWire(app) }))),
    );
  });

  // POST /api/applications — create a new application
  router.post("/", requirePermission("applications", "write"), async (c) => {
    if (c.get("authMethod") === "api_key") {
      throw forbidden("API keys cannot create applications");
    }
    const orgId = c.get("orgId");
    const user = c.get("user");
    const data = await readJsonBody(c, createApplicationSchema);

    if (data.settings?.allowedRedirectDomains) {
      const validationError = validateDomainList(data.settings.allowedRedirectDomains);
      if (validationError) throw invalidRequest(validationError);
    }

    try {
      const app = await createApplication(orgId, data, user.id);
      await recordAuditFromContext(c, {
        action: "application.created",
        resourceType: "application",
        resourceId: app.id,
        after: { name: app.name },
      });
      return c.json({ object: "application", ...toApplicationWire(app) }, 201);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Application creation failed", {
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // GET /api/applications/:id — get application detail
  router.get("/:id", requirePermission("applications", "read"), async (c) => {
    const orgId = c.get("orgId");
    const applicationId = c.req.param("id")!;

    try {
      const app = await getApplication(orgId, applicationId);
      return c.json({ object: "application", ...toApplicationWire(app) });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Failed to get application", {
        applicationId,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // PATCH /api/applications/:id — update application
  router.patch("/:id", requirePermission("applications", "write"), async (c) => {
    const orgId = c.get("orgId");
    const applicationId = c.req.param("id")!;
    const data = await readJsonBody(c, updateApplicationSchema);

    if (data.settings?.allowedRedirectDomains) {
      const validationError = validateDomainList(data.settings.allowedRedirectDomains);
      if (validationError) throw invalidRequest(validationError);
    }

    try {
      const app = await updateApplication(orgId, applicationId, data);
      await recordAuditFromContext(c, {
        action: "application.updated",
        resourceType: "application",
        resourceId: app.id,
        after: data as unknown as Record<string, unknown>,
      });
      return c.json({ object: "application", ...toApplicationWire(app) });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Application update failed", {
        applicationId,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // DELETE /api/applications/:id — delete application
  router.delete("/:id", requirePermission("applications", "delete"), async (c) => {
    const orgId = c.get("orgId");
    const applicationId = c.req.param("id")!;

    try {
      await deleteApplication(orgId, applicationId);
      await recordAuditFromContext(c, {
        action: "application.deleted",
        resourceType: "application",
        resourceId: applicationId,
      });
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Application deletion failed", {
        applicationId,
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // ─── Application Packages (install/uninstall/config) ─────────────────────

  // Guard: validate that the application belongs to the org (once for all /:applicationId/packages/* routes)
  router.use("/:applicationId/packages/*", async (c, next) => {
    await getApplication(c.get("orgId"), c.req.param("applicationId")!);
    return next();
  });
  router.use("/:applicationId/packages", async (c, next) => {
    await getApplication(c.get("orgId"), c.req.param("applicationId")!);
    return next();
  });

  // GET /api/applications/:applicationId/packages — list installed packages
  router.get("/:applicationId/packages", async (c) => {
    const applicationId = c.req.param("applicationId")!;
    const orgId = c.get("orgId");
    const type = c.req.query("type") as PackageType | undefined;
    const rows = await listInstalledPackages({ orgId, applicationId: applicationId }, type);
    return c.json(listResponse(rows.map((row) => ({ object: "application_package", ...row }))));
  });

  // POST /api/applications/:applicationId/packages — install a package
  router.post("/:applicationId/packages", requirePermission("applications", "write"), async (c) => {
    const orgId = c.get("orgId");
    const applicationId = c.req.param("applicationId")!;

    const data = await readJsonBody(c, installPackageSchema);

    await installPackage({ orgId, applicationId: applicationId }, data.packageId, data.config);
    const row = await getInstalledPackage({ orgId, applicationId: applicationId }, data.packageId);
    return c.json({ object: "application_package", ...row }, 201);
  });

  // GET /api/applications/:applicationId/packages/:packageId — get installed package detail
  router.get(`/:applicationId/packages/${SCOPED_PACKAGE_ROUTE}`, async (c) => {
    const applicationId = c.req.param("applicationId")!;
    const orgId = c.get("orgId");
    const packageId = `${c.req.param("scope")!}/${c.req.param("name")!}`;
    const row = await getInstalledPackage({ orgId, applicationId: applicationId }, packageId);
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

  // PUT /api/applications/:applicationId/packages/:packageId — update config
  router.put(
    `/:applicationId/packages/${SCOPED_PACKAGE_ROUTE}`,
    requirePermission("applications", "write"),
    async (c) => {
      const applicationId = c.req.param("applicationId")!;
      const orgId = c.get("orgId");
      const scope = { orgId, applicationId: applicationId };
      const packageId = `${c.req.param("scope")!}/${c.req.param("name")!}`;
      const data = await readJsonBody(c, updatePackageSchema);

      const { version_id, ...rest } = data;
      // `requireInstalled` — this route updates an EXISTING association; a
      // packageId that is not installed (or not visible to the org) is a 404,
      // never an implicit install via upsert.
      await updateInstalledPackage(
        scope,
        packageId,
        { ...rest, versionId: version_id },
        { requireInstalled: true },
      );
      const updated = await getInstalledPackage(scope, packageId);
      return c.json({ object: "application_package", ...updated });
    },
  );

  // DELETE /api/applications/:applicationId/packages/:packageId — uninstall
  router.delete(
    `/:applicationId/packages/${SCOPED_PACKAGE_ROUTE}`,
    requirePermission("applications", "write"),
    async (c) => {
      const applicationId = c.req.param("applicationId")!;
      const orgId = c.get("orgId");
      const packageId = `${c.req.param("scope")!}/${c.req.param("name")!}`;
      await uninstallPackage({ orgId, applicationId: applicationId }, packageId);
      return c.body(null, 204);
    },
  );

  // GET /api/applications/:applicationId/packages/:scope/:name/run-config —
  // single source of truth for the per-app config, model/proxy override,
  // and version pin. Consumed by the CLI to reproduce a UI run without
  // hand-stitching three separate calls.
  router.get(
    `/:applicationId/packages/${SCOPED_PACKAGE_ROUTE}/run-config`,
    requirePermission("agents", "read"),
    async (c) => {
      const applicationId = c.req.param("applicationId")!;
      const orgId = c.get("orgId");
      const packageId = `${c.req.param("scope")!}/${c.req.param("name")!}`;
      const resolved = await getResolvedRunConfig({ orgId, applicationId }, packageId);
      if (!resolved) {
        throw new ApiError({
          status: 404,
          code: "package_not_installed",
          title: "Package Not Installed",
          detail: `Package '${packageId}' is not installed in this application`,
        });
      }
      return c.json(resolved);
    },
  );

  return router;
}
