import { Hono } from "hono";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, packageConfigs } from "@appstrate/db/schema";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import { invalidRequest, notFound, parseBody } from "../lib/errors.ts";
import {
  listProfiles,
  createProfile,
  renameProfile,
  deleteProfile,
  getProfileForActor,
  listOrgProfiles,
  createOrgProfile,
  getOrgProfile,
  renameOrgProfile,
  deleteOrgProfile,
  listOrgProfilesWithUserBindings,
} from "../services/connection-profiles.ts";
import {
  listAllActorConnections,
  deleteAllActorConnections,
  getConnectionStatus,
} from "../services/connection-manager/index.ts";
import {
  getOrgProfileBindingsEnriched,
  bindOrgProfileProvider,
  unbindOrgProfileProvider,
} from "../services/state/index.ts";
import { getActor } from "../lib/actor.ts";
import { requireAdmin } from "../middleware/guards.ts";
import { listConnections } from "@appstrate/connect";

const profileNameSchema = z.object({ name: z.string().min(1, "Name is required").max(100) });

export function createConnectionProfilesRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/connection-profiles — list actor's profiles with connection counts
  router.get("/", async (c) => {
    const actor = getActor(c);
    const profiles = await listProfiles(actor);
    return c.json({ profiles });
  });

  // POST /api/connection-profiles — create a new profile
  router.post("/", async (c) => {
    const actor = getActor(c);
    const body = await c.req.json();
    const data = parseBody(profileNameSchema, body, "name");
    const profile = await createProfile(actor, data.name.trim());
    return c.json({ profile }, 201);
  });

  // GET /api/connection-profiles/connections — all connections across all profiles
  router.get("/connections", async (c) => {
    const actor = getActor(c);
    const result = await listAllActorConnections(actor);
    return c.json(result);
  });

  // DELETE /api/connection-profiles/connections — delete all actor connections
  router.delete("/connections", async (c) => {
    const actor = getActor(c);
    await deleteAllActorConnections(actor);
    return c.json({ ok: true });
  });

  // GET /api/connection-profiles/my-org-bindings — list org profiles where current user has bindings
  router.get("/my-org-bindings", async (c) => {
    const userId = c.get("user").id;
    const orgId = c.get("orgId");
    const profiles = await listOrgProfilesWithUserBindings(userId, orgId);
    return c.json({ profiles });
  });

  // ─── Org Profile Routes (before /:id to avoid param matching) ──

  // GET /api/connection-profiles/org — list org profiles
  router.get("/org", async (c) => {
    const orgId = c.get("orgId");
    const profiles = await listOrgProfiles(orgId);
    return c.json({ profiles });
  });

  // POST /api/connection-profiles/org — create an org profile (admin only)
  router.post("/org", requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const data = parseBody(profileNameSchema, body, "name");
    const profile = await createOrgProfile(orgId, data.name.trim());
    return c.json({ profile }, 201);
  });

  // PUT /api/connection-profiles/org/:id — rename an org profile (admin only)
  router.put("/org/:id", requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const profileId = c.req.param("id")!;
    const body = await c.req.json();
    const data = parseBody(profileNameSchema, body, "name");
    try {
      await renameOrgProfile(profileId, orgId, data.name.trim());
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to rename profile";
      logger.warn("Failed to rename org profile", { profileId, orgId, error: message });
      throw invalidRequest(message);
    }
  });

  // DELETE /api/connection-profiles/org/:id — delete an org profile (admin only)
  router.delete("/org/:id", requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const profileId = c.req.param("id")!;
    try {
      await deleteOrgProfile(profileId, orgId);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete profile";
      logger.warn("Failed to delete org profile", { profileId, orgId, error: message });
      throw invalidRequest(message);
    }
  });

  // GET /api/connection-profiles/org/:id/flows — list flows using this org profile
  router.get("/org/:id/flows", async (c) => {
    const orgId = c.get("orgId");
    const profileId = c.req.param("id")!;
    const profile = await getOrgProfile(profileId, orgId);
    if (!profile) {
      throw notFound("Profile not found");
    }

    const rows = await db
      .select({
        id: packages.id,
        displayName: sql<string>`${packages.draftManifest}->>'displayName'`,
      })
      .from(packageConfigs)
      .innerJoin(packages, eq(packages.id, packageConfigs.packageId))
      .where(and(eq(packageConfigs.orgId, orgId), eq(packageConfigs.orgProfileId, profileId)));

    return c.json({ flows: rows });
  });

  // GET /api/connection-profiles/org/:id/bindings — list provider bindings for an org profile
  router.get("/org/:id/bindings", async (c) => {
    const orgId = c.get("orgId");
    const profileId = c.req.param("id")!;
    const profile = await getOrgProfile(profileId, orgId);
    if (!profile) {
      throw notFound("Profile not found");
    }
    const bindings = await getOrgProfileBindingsEnriched(profileId);
    return c.json({ bindings });
  });

  // POST /api/connection-profiles/org/:id/bind — bind a provider to a user's connection
  router.post("/org/:id/bind", requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const userId = c.get("user").id;
    const profileId = c.req.param("id")!;
    const profile = await getOrgProfile(profileId, orgId);
    if (!profile) {
      throw notFound("Profile not found");
    }

    const body = await c.req.json();
    const data = parseBody(
      z.object({
        providerId: z.string().min(1),
        sourceProfileId: z.uuid(),
      }),
      body,
    );

    // Verify source profile belongs to the requesting user
    const actor = getActor(c);
    const sourceProfile = await getProfileForActor(data.sourceProfileId, actor);
    if (!sourceProfile) {
      throw invalidRequest("Source profile not found or does not belong to you");
    }

    // Verify the source profile has a connection for this provider
    const conn = await getConnectionStatus(data.providerId, data.sourceProfileId, orgId);
    if (conn.status !== "connected") {
      throw invalidRequest(`No active connection for '${data.providerId}' on the source profile`);
    }

    await bindOrgProfileProvider(profileId, data.providerId, data.sourceProfileId, userId);
    return c.json({ bound: true });
  });

  // DELETE /api/connection-profiles/org/:id/bind/:providerScope/:providerName — unbind a provider
  router.delete("/org/:id/bind/:providerScope{@[^/]+}/:providerName", requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const profileId = c.req.param("id")!;
    const providerId = `${c.req.param("providerScope")}/${c.req.param("providerName")}`;
    const profile = await getOrgProfile(profileId, orgId);
    if (!profile) {
      throw notFound("Profile not found");
    }
    await unbindOrgProfileProvider(profileId, providerId);
    return c.json({ unbound: true });
  });

  // ─── User Profile Routes (/:id params after static routes) ──

  // PUT /api/connection-profiles/:id — rename a profile
  router.put("/:id", async (c) => {
    const actor = getActor(c);
    const profileId = c.req.param("id")!;
    const body = await c.req.json();
    const data = parseBody(profileNameSchema, body, "name");
    try {
      await renameProfile(profileId, actor, data.name.trim());
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to rename profile";
      logger.warn("Failed to rename profile", { profileId, actorId: actor.id, error: message });
      throw invalidRequest(message);
    }
  });

  // DELETE /api/connection-profiles/:id — delete a profile
  router.delete("/:id", async (c) => {
    const actor = getActor(c);
    const profileId = c.req.param("id")!;
    try {
      await deleteProfile(profileId, actor);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete profile";
      logger.warn("Failed to delete profile", { profileId, actorId: actor.id, error: message });
      throw invalidRequest(message);
    }
  });

  // GET /api/connection-profiles/:id/connections — list connections for a profile
  router.get("/:id/connections", async (c) => {
    const actor = getActor(c);
    const profileId = c.req.param("id")!;
    // Verify the profile belongs to the authenticated actor or the org
    const orgId = c.get("orgId");
    const profile =
      (await getProfileForActor(profileId, actor)) ?? (await getOrgProfile(profileId, orgId));
    if (!profile) {
      throw notFound("Profile not found");
    }
    const connections = await listConnections(db, profileId, orgId);
    return c.json({ connections });
  });

  return router;
}
