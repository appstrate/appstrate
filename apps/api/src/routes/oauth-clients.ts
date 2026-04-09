// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth Client Admin Routes
 *
 * Manage OAuth client configuration per application.
 * Each application with endUserAuth.enabled = true has a single OAuth client
 * with skipConsent (first-party, same pattern as Auth0/Firebase).
 */

import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../types/index.ts";
import { invalidRequest, conflict, parseBody } from "../lib/errors.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { getApplication, updateApplication, type AppSettings } from "../services/applications.ts";
import { auth } from "@appstrate/db/auth";
import { db } from "@appstrate/db/client";
import { oauthClient } from "@appstrate/db/schema";
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

/**
 * Call Better Auth's internal handler for OAuth client management.
 * Forwards the session cookie and sets the required Origin header.
 */
async function callBetterAuth(
  c: { req: { url: string; header: (name: string) => string | undefined } },
  path: string,
  method: string,
  body: unknown,
): Promise<Response> {
  return auth.handler(
    new Request(new URL(path, c.req.url).href, {
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: c.req.header("cookie") ?? "",
        Origin: new URL(c.req.url).origin,
      },
      body: JSON.stringify(body),
    }),
  );
}

export function createOAuthClientsRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/applications/:id/oauth — Enable end-user auth
  router.post("/:id/oauth", requirePermission("applications", "write"), async (c) => {
    const orgId = c.get("orgId")!;
    const appId = c.req.param("id")!;
    const body = parseBody(enableOAuthSchema, await c.req.json());

    const app = await getApplication(orgId, appId);
    const currentSettings = (app.settings ?? {}) as AppSettings;

    // Idempotence: reject if already enabled
    if (currentSettings.endUserAuth?.enabled && currentSettings.endUserAuth?.clientId) {
      throw conflict(
        "oauth_already_enabled",
        "End-user auth is already enabled for this application",
      );
    }

    // Create OAuth client via Better Auth
    const createRes = await callBetterAuth(c, "/api/auth/oauth2/create-client", "POST", {
      name: app.name,
      redirect_uris: body.redirectUris,
      scope: "openid profile email",
    });

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

    // First-party apps: skip consent + link to application via referenceId.
    // The create-client endpoint blocks skip_consent during dynamic registration,
    // so we set it directly after creation along with the application reference.
    await db
      .update(oauthClient)
      .set({ skipConsent: true, referenceId: appId })
      .where(eq(oauthClient.clientId, client.client_id));

    // Persist clientId in application settings
    await updateApplication(orgId, appId, {
      settings: {
        ...currentSettings,
        endUserAuth: {
          enabled: true,
          clientId: client.client_id,
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

    if (!endUserAuth?.enabled || !endUserAuth.clientId) {
      return c.json({ enabled: false });
    }

    // Fetch redirect URIs from the OAuth client record
    const [client] = await db
      .select({ redirectUris: oauthClient.redirectUris })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, endUserAuth.clientId))
      .limit(1);

    return c.json({
      enabled: true,
      clientId: endUserAuth.clientId,
      allowSignup: endUserAuth.allowSignup ?? true,
      requireEmailVerification: endUserAuth.requireEmailVerification ?? true,
      redirectUris: client?.redirectUris ?? [],
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

    if (!endUserAuth?.enabled || !endUserAuth.clientId) {
      throw invalidRequest("End-user auth is not enabled for this application");
    }

    // Update redirect URIs in Better Auth if provided
    if (body.redirectUris) {
      const updateRes = await callBetterAuth(c, "/api/auth/oauth2/update-client", "POST", {
        client_id: endUserAuth.clientId,
        update: { redirect_uris: body.redirectUris },
      });

      if (!updateRes.ok) {
        const errBody = await updateRes.text();
        logger.error("Failed to update OAuth client redirect URIs", {
          status: updateRes.status,
          body: errBody,
          clientId: endUserAuth.clientId,
        });
        throw invalidRequest("Failed to update OAuth client configuration.");
      }
    }

    // Update application settings
    await updateApplication(orgId, appId, {
      settings: {
        ...settings,
        endUserAuth: {
          ...endUserAuth,
          ...(body.allowSignup !== undefined && { allowSignup: body.allowSignup }),
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
    const endUserAuth = settings.endUserAuth;

    if (!endUserAuth?.enabled || !endUserAuth.clientId) {
      return c.json({ enabled: false });
    }

    // Disable the OAuth client in Better Auth (tokens stop working)
    await db
      .update(oauthClient)
      .set({ disabled: true })
      .where(eq(oauthClient.clientId, endUserAuth.clientId));

    // Clear settings
    await updateApplication(orgId, appId, {
      settings: {
        ...settings,
        endUserAuth: {
          enabled: false,
          allowSignup: true,
          requireEmailVerification: true,
        },
      },
    });

    logger.info("OAuth client disabled for application", {
      applicationId: appId,
      clientId: endUserAuth.clientId,
      orgId,
    });

    return c.json({ enabled: false });
  });

  return router;
}
