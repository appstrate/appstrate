// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { profiles, user as userTable, organizationMembers } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import type { AppEnv } from "../types/index.ts";
import { internalError, notFound, parseBody } from "../lib/errors.ts";
import { scopedWhere } from "../lib/db-helpers.ts";

export const profileUpdateSchema = z.object({
  language: z.enum(["fr", "en"]).optional(),
  displayName: z.string().min(1).max(100).optional(),
});

export const batchLookupSchema = z.object({
  ids: z.array(z.string()).max(100),
});

const profileRouter = new Hono<AppEnv>();

profileRouter.get("/profile", async (c) => {
  const user = c.get("user");
  const rows = await db.select().from(profiles).where(eq(profiles.id, user.id)).limit(1);

  if (!rows[0]) {
    throw notFound("Profile not found");
  }

  return c.json({
    id: rows[0].id,
    displayName: rows[0].displayName,
    language: rows[0].language,
  });
});

profileRouter.patch("/profile", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();

  const data = parseBody(profileUpdateSchema, body);

  const { language, displayName } = data;

  try {
    const profileUpdates: Record<string, unknown> = {};
    if (language) profileUpdates.language = language;
    if (displayName) profileUpdates.displayName = displayName;

    if (Object.keys(profileUpdates).length > 0) {
      await db.update(profiles).set(profileUpdates).where(eq(profiles.id, user.id));
    }

    if (displayName) {
      await db.update(userTable).set({ name: displayName }).where(eq(userTable.id, user.id));
    }
  } catch (err) {
    logger.error("Failed to update profile", {
      userId: user.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw internalError();
  }

  return c.json({ ok: true, language: language ?? null, displayName: displayName ?? null });
});

// POST /api/profiles/batch — batch lookup display names by user IDs (scoped to org members)
profileRouter.post("/profiles/batch", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json();
  const data = parseBody(batchLookupSchema, body);
  const ids = data.ids.filter(Boolean);
  if (ids.length === 0) return c.json({ profiles: [] });

  const rows = await db
    .select({ id: profiles.id, displayName: profiles.displayName })
    .from(profiles)
    .innerJoin(organizationMembers, eq(profiles.id, organizationMembers.userId))
    .where(scopedWhere(organizationMembers, { orgId, extra: [inArray(profiles.id, ids)] }));

  return c.json({ profiles: rows });
});

export default profileRouter;
