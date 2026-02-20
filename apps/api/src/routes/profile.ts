import { Hono } from "hono";
import { z } from "zod";
import { supabase } from "../lib/supabase.ts";
import { logger } from "../lib/logger.ts";
import type { AppEnv } from "../types/index.ts";

const languageSchema = z.object({
  language: z.enum(["fr", "en"]),
});

const profileRouter = new Hono<AppEnv>();

profileRouter.patch("/profile", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();

  const parsed = languageSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid input" },
      400,
    );
  }

  const { error } = await supabase
    .from("profiles")
    .update({ language: parsed.data.language })
    .eq("id", user.id);

  if (error) {
    logger.error("Failed to update profile language", { userId: user.id, error: error.message });
    return c.json({ error: "UPDATE_FAILED", message: error.message }, 500);
  }

  return c.json({ language: parsed.data.language });
});

export default profileRouter;
