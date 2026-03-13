import { Hono } from "hono";
import { db } from "../lib/db.ts";
import { profiles, user } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../types/index.ts";

const router = new Hono<AppEnv>();

// POST /api/welcome/setup — set display name after invitation
router.post("/welcome/setup", async (c) => {
  const currentUser = c.get("user");
  if (!currentUser?.id) {
    return c.json({ error: "UNAUTHORIZED", message: "Non authentifie" }, 401);
  }

  const body = await c.req.json<{ displayName?: string }>();

  // Update display name if provided
  if (body.displayName?.trim()) {
    const trimmed = body.displayName.trim();
    await Promise.all([
      db
        .update(profiles)
        .set({ displayName: trimmed, updatedAt: new Date() })
        .where(eq(profiles.id, currentUser.id)),
      db
        .update(user)
        .set({ name: trimmed, updatedAt: new Date() })
        .where(eq(user.id, currentUser.id)),
    ]);
  }

  return c.json({ ok: true });
});

export default router;
