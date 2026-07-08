// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { forbidden, unauthorized } from "../lib/errors.ts";
import { readJsonBody } from "../lib/request-body.ts";
import { setDisplayName } from "../services/profile.ts";

export const welcomeSetupSchema = z.object({
  displayName: z.string().max(100).optional(),
});

const router = new Hono<AppEnv>();

// POST /api/welcome/setup — set display name after invitation
router.post("/welcome/setup", async (c) => {
  // Issue #172 (extension) — same-class as PATCH /api/profile: this
  // mutates the BA-owned `user.name`. API key callers (customer
  // integrations) must not be able to rename the dashboard owner.
  if (c.get("authMethod") === "api_key") {
    throw forbidden("API keys cannot complete dashboard onboarding");
  }
  const currentUser = c.get("user");
  if (!currentUser?.id) {
    throw unauthorized("Not authenticated");
  }

  const data = await readJsonBody(c, welcomeSetupSchema);

  // Update display name if provided
  if (data.displayName?.trim()) {
    await setDisplayName(currentUser.id, data.displayName.trim());
  }

  // 204: onboarding ack, no resource to return (the profile lives under
  // GET /api/profile and the frontend redirects without reading a body).
  return c.body(null, 204);
});

export default router;
