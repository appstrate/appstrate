// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import { ApiError, invalidRequest, notFound, internalError, parseBody } from "../lib/errors.ts";
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
import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applicationProviderCredentials, packages } from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";
import { hasActualCredentials } from "../lib/provider-config.ts";
import { orgOrSystemFilter } from "../lib/package-helpers.ts";

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

  // Guard: validate that the application belongs to the org (once for all /:appId/packages/* routes)
  router.use("/:appId/packages/*", async (c, next) => {
    await getApplication(c.get("orgId"), c.req.param("appId")!);
    return next();
  });
  router.use("/:appId/packages", async (c, next) => {
    await getApplication(c.get("orgId"), c.req.param("appId")!);
    return next();
  });

  // GET /api/applications/:appId/packages — list installed packages
  router.get("/:appId/packages", async (c) => {
    const appId = c.req.param("appId")!;
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

    const body = await c.req.json();
    const data = parseBody(installPackageSchema, body);

    const row = await installPackage(appId, orgId, data.packageId, data.config);
    return c.json({ object: "application_package", ...row }, 201);
  });

  // GET /api/applications/:appId/packages/:packageId — get installed package detail
  router.get("/:appId/packages/:scope{@[^/]+}/:name", async (c) => {
    const appId = c.req.param("appId")!;
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
      const appId = c.req.param("appId")!;
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
      const appId = c.req.param("appId")!;
      const packageId = `${c.req.param("scope")!}/${c.req.param("name")!}`;
      await uninstallPackage(appId, packageId);
      return c.body(null, 204);
    },
  );

  // ─── Application-level provider credentials ──────────────────────────

  // Middleware: validate app exists for provider routes
  router.use("/:appId/providers/*", async (c, next) => {
    await getApplication(c.get("orgId"), c.req.param("appId")!);
    return next();
  });

  const appProviderCredentialsSchema = z.object({
    credentials: z.record(z.string(), z.string().min(1)).optional(),
    enabled: z.boolean().optional(),
  });

  // PUT /api/applications/:appId/providers/:scope/:name/credentials — set app-level credentials
  router.put(
    "/:appId/providers/:scope{@[^/]+}/:name/credentials",
    requirePermission("providers", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const appId = c.req.param("appId")!;
      const providerId = `${c.req.param("scope")!}/${c.req.param("name")!}`;
      const body = await c.req.json();
      const data = parseBody(appProviderCredentialsSchema, body);

      // Verify provider exists
      const [pkg] = await db
        .select({ id: packages.id })
        .from(packages)
        .where(
          and(orgOrSystemFilter(orgId), eq(packages.id, providerId), eq(packages.type, "provider")),
        )
        .limit(1);

      if (!pkg) throw notFound("Provider not found");

      const hasCredentials = data.credentials && Object.keys(data.credentials).length > 0;
      const setClause: Record<string, unknown> = { updatedAt: new Date() };
      if (hasCredentials) {
        setClause.credentialsEncrypted = encryptCredentials(data.credentials!);
      }
      if (data.enabled !== undefined) {
        setClause.enabled = data.enabled;
      }

      await db
        .insert(applicationProviderCredentials)
        .values({
          applicationId: appId,
          providerId,
          credentialsEncrypted: hasCredentials
            ? encryptCredentials(data.credentials!)
            : encryptCredentials({}),
          enabled: data.enabled ?? true,
        })
        .onConflictDoUpdate({
          target: [
            applicationProviderCredentials.applicationId,
            applicationProviderCredentials.providerId,
          ],
          set: setClause,
        });

      return c.json({ configured: true });
    },
  );

  // DELETE /api/applications/:appId/providers/:scope/:name/credentials — remove app-level override
  router.delete(
    "/:appId/providers/:scope{@[^/]+}/:name/credentials",
    requirePermission("providers", "write"),
    async (c) => {
      const appId = c.req.param("appId")!;
      const providerId = `${c.req.param("scope")!}/${c.req.param("name")!}`;

      await db
        .delete(applicationProviderCredentials)
        .where(
          and(
            eq(applicationProviderCredentials.applicationId, appId),
            eq(applicationProviderCredentials.providerId, providerId),
          ),
        );

      return c.body(null, 204);
    },
  );

  // GET /api/applications/:appId/providers — list providers with app-level override status
  router.get("/:appId/providers", async (c) => {
    const appId = c.req.param("appId")!;

    const appCreds = await db
      .select({
        providerId: applicationProviderCredentials.providerId,
        hasCredentials: applicationProviderCredentials.credentialsEncrypted,
        enabled: applicationProviderCredentials.enabled,
      })
      .from(applicationProviderCredentials)
      .where(eq(applicationProviderCredentials.applicationId, appId));

    const overrides = appCreds.map((row) => ({
      providerId: row.providerId,
      hasAppCredentials: hasActualCredentials(row.hasCredentials),
      appEnabled: row.enabled,
    }));

    return c.json({ object: "list", data: overrides });
  });

  return router;
}
