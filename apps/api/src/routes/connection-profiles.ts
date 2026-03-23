import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import { invalidRequest, notFound } from "../lib/errors.ts";
import {
  listProfiles,
  createProfile,
  renameProfile,
  deleteProfile,
  getProfileForActor,
} from "../services/connection-profiles.ts";
import {
  listAllActorConnections,
  deleteAllActorConnections,
} from "../services/connection-manager/index.ts";
import { getActor } from "../lib/actor.ts";
import { listConnections } from "@appstrate/connect";
import { db } from "../lib/db.ts";

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
    const parsed = profileNameSchema.safeParse(body);
    if (!parsed.success) {
      throw invalidRequest(parsed.error.issues[0]!.message, "name");
    }
    const profile = await createProfile(actor, parsed.data.name.trim());
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

  // PUT /api/connection-profiles/:id — rename a profile
  router.put("/:id", async (c) => {
    const actor = getActor(c);
    const profileId = c.req.param("id");
    const body = await c.req.json();
    const parsed = profileNameSchema.safeParse(body);
    if (!parsed.success) {
      throw invalidRequest(parsed.error.issues[0]!.message, "name");
    }
    try {
      await renameProfile(profileId, actor, parsed.data.name.trim());
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
    const profileId = c.req.param("id");
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
    const profileId = c.req.param("id");
    // Verify the profile belongs to the authenticated actor (single query, not fetch-all)
    const profile = await getProfileForActor(profileId, actor);
    if (!profile) {
      throw notFound("Profile not found");
    }
    const orgId = c.get("orgId");
    const connections = await listConnections(db, profileId, orgId);
    return c.json({ connections });
  });

  return router;
}
