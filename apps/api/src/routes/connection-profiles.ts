import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import {
  listProfiles,
  createProfile,
  renameProfile,
  deleteProfile,
  getProfileForUser,
} from "../services/connection-profiles.ts";
import {
  listAllUserConnections,
  deleteAllUserConnections,
} from "../services/connection-manager/index.ts";
import { listConnections } from "@appstrate/connect";
import { db } from "../lib/db.ts";

export function createConnectionProfilesRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/connection-profiles — list user's profiles with connection counts
  router.get("/", async (c) => {
    const user = c.get("user");
    const profiles = await listProfiles(user.id);
    return c.json({ profiles });
  });

  // POST /api/connection-profiles — create a new profile
  router.post("/", async (c) => {
    const user = c.get("user");
    const body = await c.req.json<{ name?: string }>();
    if (!body.name?.trim()) {
      return c.json({ error: "VALIDATION_ERROR", message: "Name is required" }, 400);
    }
    const profile = await createProfile(user.id, body.name.trim());
    return c.json({ profile }, 201);
  });

  // GET /api/connection-profiles/connections — all connections across all profiles
  router.get("/connections", async (c) => {
    const user = c.get("user");
    const result = await listAllUserConnections(user.id);
    return c.json(result);
  });

  // DELETE /api/connection-profiles/connections — delete all user connections
  router.delete("/connections", async (c) => {
    const user = c.get("user");
    await deleteAllUserConnections(user.id);
    return c.json({ ok: true });
  });

  // PUT /api/connection-profiles/:id — rename a profile
  router.put("/:id", async (c) => {
    const user = c.get("user");
    const profileId = c.req.param("id");
    const body = await c.req.json<{ name?: string }>();
    if (!body.name?.trim()) {
      return c.json({ error: "VALIDATION_ERROR", message: "Name is required" }, 400);
    }
    try {
      await renameProfile(profileId, user.id, body.name.trim());
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to rename profile";
      logger.warn("Failed to rename profile", { profileId, userId: user.id, error: message });
      return c.json({ error: "RENAME_FAILED", message }, 400);
    }
  });

  // DELETE /api/connection-profiles/:id — delete a profile
  router.delete("/:id", async (c) => {
    const user = c.get("user");
    const profileId = c.req.param("id");
    try {
      await deleteProfile(profileId, user.id);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete profile";
      logger.warn("Failed to delete profile", { profileId, userId: user.id, error: message });
      return c.json({ error: "DELETE_FAILED", message }, 400);
    }
  });

  // GET /api/connection-profiles/:id/connections — list connections for a profile
  router.get("/:id/connections", async (c) => {
    const user = c.get("user");
    const profileId = c.req.param("id");
    // Verify the profile belongs to the authenticated user (single query, not fetch-all)
    const profile = await getProfileForUser(profileId, user.id);
    if (!profile) {
      return c.json({ error: "NOT_FOUND", message: "Profile not found" }, 404);
    }
    const orgId = c.get("orgId");
    const connections = await listConnections(db, profileId, orgId);
    return c.json({ connections });
  });

  return router;
}
