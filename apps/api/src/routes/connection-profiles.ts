// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import { invalidRequest, parseBody } from "../lib/errors.ts";
import {
  listProfiles,
  createProfile,
  renameProfile,
  deleteProfile,
} from "../services/connection-profiles.ts";
import { getActor } from "../lib/actor.ts";

import { rateLimit } from "../middleware/rate-limit.ts";
import { z } from "zod";

export const profileNameSchema = z.object({ name: z.string().min(1, "Name is required").max(100) });

export function createConnectionProfilesRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/connection-profiles — list actor's profiles with connection counts
  router.get("/", async (c) => {
    const actor = getActor(c);
    const profiles = await listProfiles(actor);
    return c.json({ profiles });
  });

  // POST /api/connection-profiles — create a new profile
  router.post("/", rateLimit(10), async (c) => {
    const actor = getActor(c);
    const body = await c.req.json();
    const data = parseBody(profileNameSchema, body, "name");
    const profile = await createProfile(actor, data.name.trim());
    return c.json({ profile }, 201);
  });

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

  return router;
}
