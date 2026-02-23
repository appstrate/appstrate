import { Hono } from "hono";
import { db } from "../lib/db.ts";
import { profiles, user, account } from "@appstrate/db/schema";
import { eq, and } from "drizzle-orm";
import { hashPassword } from "../lib/auth.ts";
import type { AppEnv } from "../types/index.ts";

const router = new Hono<AppEnv>();

// POST /api/welcome/setup — set display name and/or password after invitation
router.post("/welcome/setup", async (c) => {
  const currentUser = c.get("user");
  if (!currentUser?.id) {
    return c.json({ error: "UNAUTHORIZED", message: "Non authentifie" }, 401);
  }

  const body = await c.req.json<{ displayName?: string; password?: string }>();

  // Update password if provided
  if (body.password) {
    if (body.password.length < 8) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "Le mot de passe doit contenir au moins 8 caracteres",
        },
        400,
      );
    }

    const hashed = await hashPassword(body.password);
    await db
      .update(account)
      .set({ password: hashed, updatedAt: new Date() })
      .where(and(eq(account.userId, currentUser.id), eq(account.providerId, "credential")));
  }

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
