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
import { validateDomainList } from "../services/redirect-validation.ts";

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
  router.post("/", async (c) => {
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
  router.patch("/:id", async (c) => {
    const orgId = c.get("orgId");
    const appId = c.req.param("id");
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
  router.delete("/:id", async (c) => {
    const orgId = c.get("orgId");
    const appId = c.req.param("id");

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

  return router;
}
