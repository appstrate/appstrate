import { Hono } from "hono";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { profiles, user as userTable } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import type { AppEnv } from "../types/index.ts";

const profileUpdateSchema = z.object({
  language: z.enum(["fr", "en"]).optional(),
  displayName: z.string().min(1).max(100).optional(),
});

const profileRouter = new Hono<AppEnv>();

profileRouter.get("/profile", async (c) => {
  const user = c.get("user");
  const rows = await db.select().from(profiles).where(eq(profiles.id, user.id)).limit(1);

  if (!rows[0]) {
    return c.json({ error: "NOT_FOUND", message: "Profile not found" }, 404);
  }

  return c.json({
    id: rows[0].id,
    display_name: rows[0].displayName,
    language: rows[0].language,
  });
});

profileRouter.patch("/profile", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();

  const parsed = profileUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid input" },
      400,
    );
  }

  const { language, displayName } = parsed.data;

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
    return c.json({ error: "UPDATE_FAILED", message: "Failed to update profile" }, 500);
  }

  return c.json({ ok: true, ...(language && { language }), ...(displayName && { displayName }) });
});

// POST /api/profiles/batch — batch lookup display names by user IDs
profileRouter.post("/profiles/batch", async (c) => {
  const body = await c.req.json<{ ids: string[] }>();
  const ids = body.ids?.filter(Boolean)?.slice(0, 100) ?? [];
  if (ids.length === 0) return c.json({ profiles: [] });

  const rows = await db
    .select({ id: profiles.id, display_name: profiles.displayName })
    .from(profiles)
    .where(inArray(profiles.id, ids));

  return c.json({ profiles: rows });
});

export default profileRouter;
