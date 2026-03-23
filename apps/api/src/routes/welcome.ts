import { Hono } from "hono";
import { z } from "zod";
import { db } from "../lib/db.ts";
import { profiles, user } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../types/index.ts";
import { unauthorized, invalidRequest } from "../lib/errors.ts";

const welcomeSetupSchema = z.object({
  displayName: z.string().max(100).optional(),
});

const router = new Hono<AppEnv>();

// POST /api/welcome/setup — set display name after invitation
router.post("/welcome/setup", async (c) => {
  const currentUser = c.get("user");
  if (!currentUser?.id) {
    throw unauthorized("Not authenticated");
  }

  const body = await c.req.json();
  const parsed = welcomeSetupSchema.safeParse(body);
  if (!parsed.success) {
    throw invalidRequest(parsed.error.issues[0]!.message);
  }

  // Update display name if provided
  if (parsed.data.displayName?.trim()) {
    const trimmed = parsed.data.displayName.trim();
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
