// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth Client Admin Routes
 *
 * Manage OAuth client configuration per application.
 * Each application with endUserAuth.enabled = true acts as an OAuth client.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { invalidRequest, parseBody } from "../lib/errors.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { getApplication, updateApplication, type AppSettings } from "../services/applications.ts";
import { auth } from "@appstrate/db/auth";
import { logger } from "../lib/logger.ts";

const enableOAuthSchema = z.object({
  redirectUris: z.array(z.string().url()).min(1, "At least one redirect URI is required"),
  allowSignup: z.boolean().default(true),
  requireEmailVerification: z.boolean().default(true),
});

const updateOAuthSchema = z.object({
  redirectUris: z.array(z.string().url()).min(1).optional(),
  allowSignup: z.boolean().optional(),
  requireEmailVerification: z.boolean().optional(),
});

export function createOAuthClientsRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/applications/:id/oauth — Enable end-user auth
  router.post("/:id/oauth", requirePermission("applications", "write"), async (c) => {
    const orgId = c.get("orgId")!;
    const appId = c.req.param("id")!;
    const body = parseBody(enableOAuthSchema, await c.req.json());

    const app = await getApplication(orgId, appId);

    // Create OAuth client via Better Auth's internal endpoint
    const createRes = await auth.handler(
      new Request(new URL("/api/auth/oauth2/create-client", c.req.url).href, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: c.req.header("cookie") ?? "",
        },
        body: JSON.stringify({
          name: app.name,
          redirect_uris: body.redirectUris,
        }),
      }),
    );

    if (!createRes.ok) {
      const errBody = await createRes.text();
      logger.error("Failed to create OAuth client", {
        status: createRes.status,
        body: errBody,
      });
      throw invalidRequest("Failed to create OAuth client. Ensure you are authenticated.");
    }

    const client = (await createRes.json()) as {
      client_id: string;
      client_secret: string;
    };

    // Update application settings
    const currentSettings = (app.settings ?? {}) as AppSettings;
    await updateApplication(orgId, appId, {
      settings: {
        ...currentSettings,
        endUserAuth: {
          enabled: true,
          allowSignup: body.allowSignup,
          requireEmailVerification: body.requireEmailVerification,
        },
      },
    });

    logger.info("OAuth client created for application", {
      applicationId: appId,
      clientId: client.client_id,
      orgId,
    });

    return c.json(
      {
        clientId: client.client_id,
        clientSecret: client.client_secret,
        redirectUris: body.redirectUris,
        enabled: true,
      },
      201,
    );
  });

  // GET /api/applications/:id/oauth — Get OAuth config
  router.get("/:id/oauth", async (c) => {
    const orgId = c.get("orgId");
    const appId = c.req.param("id");

    const app = await getApplication(orgId, appId);
    const settings = (app.settings ?? {}) as AppSettings;
    const endUserAuth = settings.endUserAuth;

    if (!endUserAuth?.enabled) {
      return c.json({ enabled: false });
    }

    return c.json({
      enabled: true,
      allowSignup: endUserAuth.allowSignup ?? true,
      requireEmailVerification: endUserAuth.requireEmailVerification ?? true,
    });
  });

  // PATCH /api/applications/:id/oauth — Update OAuth config
  router.patch("/:id/oauth", requirePermission("applications", "write"), async (c) => {
    const orgId = c.get("orgId")!;
    const appId = c.req.param("id")!;
    const body = parseBody(updateOAuthSchema, await c.req.json());

    const app = await getApplication(orgId, appId);
    const settings = (app.settings ?? {}) as AppSettings;
    const endUserAuth = settings.endUserAuth;

    if (!endUserAuth?.enabled) {
      throw invalidRequest("End-user auth is not enabled for this application");
    }

    await updateApplication(orgId, appId, {
      settings: {
        ...settings,
        endUserAuth: {
          ...endUserAuth,
          ...(body.allowSignup !== undefined && {
            allowSignup: body.allowSignup,
          }),
          ...(body.requireEmailVerification !== undefined && {
            requireEmailVerification: body.requireEmailVerification,
          }),
        },
      },
    });

    return c.json({ updated: true });
  });

  // DELETE /api/applications/:id/oauth — Disable end-user auth
  router.delete("/:id/oauth", requirePermission("applications", "write"), async (c) => {
    const orgId = c.get("orgId")!;
    const appId = c.req.param("id")!;

    const app = await getApplication(orgId, appId);
    const settings = (app.settings ?? {}) as AppSettings;

    if (!settings.endUserAuth?.enabled) {
      return c.json({ enabled: false });
    }

    await updateApplication(orgId, appId, {
      settings: {
        ...settings,
        endUserAuth: { enabled: false, allowSignup: true, requireEmailVerification: true },
      },
    });

    logger.info("OAuth client disabled for application", {
      applicationId: appId,
      orgId,
    });

    return c.json({ enabled: false });
  });

  return router;
}
