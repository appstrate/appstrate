// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, applicationPackages } from "@appstrate/db/schema";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import { invalidRequest, notFound, parseBody } from "../lib/errors.ts";
import { listResponse } from "../lib/list-response.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import {
  listAppProfiles,
  createAppProfile,
  getAppProfile,
  renameAppProfile,
  deleteAppProfile,
  listAppProfilesWithUserBindings,
} from "../services/connection-profiles.ts";
import { getAppScope } from "../lib/scope.ts";

import { rateLimit } from "../middleware/rate-limit.ts";
import { profileNameSchema } from "../lib/common-schemas.ts";
import { recordAuditFromContext } from "../services/audit.ts";

export { profileNameSchema };

async function requireAppProfile(
  scope: import("../lib/scope.ts").AppScope,
  connectionProfileId: string,
) {
  const profile = await getAppProfile(scope, connectionProfileId);
  if (!profile) throw notFound("Profile not found");
  return profile;
}

export function createAppProfilesRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/app-profiles/my-bindings — list app profiles where current user has bindings
  router.get("/my-bindings", async (c) => {
    const scope = getAppScope(c);
    const userId = c.get("user").id;
    const profiles = await listAppProfilesWithUserBindings(scope, userId);
    return c.json(listResponse(profiles));
  });

  // GET /api/app-profiles — list app profiles
  router.get("/", async (c) => {
    const scope = getAppScope(c);
    const profiles = await listAppProfiles(scope);
    return c.json(listResponse(profiles));
  });

  // POST /api/app-profiles — create an app profile
  router.post("/", rateLimit(10), requirePermission("app-profiles", "write"), async (c) => {
    const scope = getAppScope(c);
    const body = await c.req.json();
    const data = parseBody(profileNameSchema, body, "name");
    const profile = await createAppProfile(scope, data.name.trim());
    await recordAuditFromContext(c, {
      action: "app_profile.created",
      resourceType: "app_profile",
      resourceId: profile.id,
      after: { name: profile.name },
    });
    return c.json({ profile }, 201);
  });

  // PUT /api/app-profiles/:id — rename an app profile
  router.put("/:id", requirePermission("app-profiles", "write"), async (c) => {
    const scope = getAppScope(c);
    const connectionProfileId = c.req.param("id")!;
    const body = await c.req.json();
    const data = parseBody(profileNameSchema, body, "name");
    try {
      await renameAppProfile(scope, connectionProfileId, data.name.trim());
      await recordAuditFromContext(c, {
        action: "app_profile.renamed",
        resourceType: "app_profile",
        resourceId: connectionProfileId,
        after: { name: data.name.trim() },
      });
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to rename profile";
      logger.warn("Failed to rename app profile", {
        connectionProfileId,
        applicationId: scope.applicationId,
        error: message,
      });
      throw invalidRequest(message);
    }
  });

  // DELETE /api/app-profiles/:id — delete an app profile
  router.delete("/:id", requirePermission("app-profiles", "delete"), async (c) => {
    const scope = getAppScope(c);
    const connectionProfileId = c.req.param("id")!;
    try {
      await deleteAppProfile(scope, connectionProfileId);
      await recordAuditFromContext(c, {
        action: "app_profile.deleted",
        resourceType: "app_profile",
        resourceId: connectionProfileId,
      });
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete profile";
      logger.warn("Failed to delete app profile", {
        connectionProfileId,
        applicationId: scope.applicationId,
        error: message,
      });
      throw invalidRequest(message);
    }
  });

  // GET /api/app-profiles/:id/agents — list agents using this app profile
  router.get("/:id/agents", async (c) => {
    const scope = getAppScope(c);
    const connectionProfileId = c.req.param("id")!;
    await requireAppProfile(scope, connectionProfileId);

    const rows = await db
      .select({
        id: packages.id,
        displayName: sql<string>`${packages.draftManifest}->>'displayName'`,
      })
      .from(applicationPackages)
      .innerJoin(packages, eq(packages.id, applicationPackages.packageId))
      .where(eq(applicationPackages.appProfileId, connectionProfileId));

    return c.json(listResponse(rows));
  });

  return router;
}
