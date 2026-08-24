// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { getAuth } from "@appstrate/db/auth";
import { profiles, user as userTable, organizationMembers } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import type { AppEnv } from "../types/index.ts";
import { conflict, forbidden, internalError, notFound } from "../lib/errors.ts";
import { readJsonBody } from "../lib/request-body.ts";
import { listResponse } from "../lib/list-response.ts";
import { scopedWhere } from "../lib/db-helpers.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { setDisplayName } from "../services/profile.ts";

export const profileUpdateSchema = z.object({
  language: z.enum(["fr", "en"]).optional(),
  displayName: z.string().min(1).max(100).optional(),
});

export const batchLookupSchema = z.object({
  ids: z.array(z.string()).max(100),
});

// Bounds mirror the Better Auth password config (`minPasswordLength: 8` in
// packages/db/src/auth.ts) so validation fails here with a proper RFC 9457
// response instead of surfacing a BA APIError.
export const setPasswordSchema = z.object({
  newPassword: z.string().min(8).max(128),
});

const profileRouter = new Hono<AppEnv>();

// Single profile serializer — shared by GET and PATCH so both return the
// exact same resource shape (issue #657). Intentionally joins `profiles`
// with `user` so the response carries the authoritative (BA-owned) email —
// the CLI's `whoami` surfaces this as the "current identity" check,
// catching cases where the locally cached email is stale after a
// dashboard-side email change. One indexed join on the user PK is cheap
// versus maintaining a second email copy on `profiles`.
async function getProfileResource(userId: string) {
  const rows = await db
    .select({
      id: profiles.id,
      displayName: profiles.displayName,
      language: profiles.language,
      email: userTable.email,
      name: userTable.name,
    })
    .from(profiles)
    .innerJoin(userTable, eq(userTable.id, profiles.id))
    .where(eq(profiles.id, userId))
    .limit(1);

  return rows[0] ?? null;
}

// Issue #172 (extension) — `/api/profile` is the dashboard user's own
// identity record (Better Auth-owned `user.name` is mutated by PATCH).
// API keys must not be able to read or rewrite the human creator's
// account: a customer integration shouldn't get the platform user's
// PII via GET, nor be able to rename the dashboard owner via PATCH.
profileRouter.get("/profile", async (c) => {
  if (c.get("authMethod") === "api_key") {
    throw forbidden("API keys cannot access the dashboard user profile");
  }
  const user = c.get("user");
  const profile = await getProfileResource(user.id);
  if (!profile) {
    throw notFound("Profile not found");
  }

  return c.json(profile);
});

profileRouter.patch("/profile", async (c) => {
  if (c.get("authMethod") === "api_key") {
    throw forbidden("API keys cannot modify the dashboard user profile");
  }
  const user = c.get("user");

  const data = await readJsonBody(c, profileUpdateSchema);

  const { language, displayName } = data;

  try {
    // `language` lives only on `profiles`; update it inline. `displayName`
    // is mirrored across `profiles` + Better Auth `user.name`, so it goes
    // through the shared dual-write service (also stamps `updatedAt`).
    if (language) {
      await db.update(profiles).set({ language }).where(eq(profiles.id, user.id));
    }

    if (displayName) {
      await setDisplayName(user.id, displayName);
    }
  } catch (err) {
    logger.error("Failed to update profile", {
      userId: user.id,
      error: getErrorMessage(err),
    });
    throw internalError();
  }

  // Bare updated resource — same serializer as GET /api/profile (issue #657).
  const profile = await getProfileResource(user.id);
  if (!profile) {
    throw notFound("Profile not found");
  }

  return c.json(profile);
});

// POST /api/profile/password — set an initial password for accounts created
// via social sign-in (Google/GitHub) that have no `credential` account yet.
// Delegates to Better Auth's server-only `setPassword`, which creates the
// credential account or rejects with PASSWORD_ALREADY_SET when one exists —
// existing passwords can only be changed via `changePassword` (requires the
// current password), never overwritten here.
profileRouter.post("/profile/password", async (c) => {
  if (c.get("authMethod") === "api_key") {
    throw forbidden("API keys cannot set the dashboard user password");
  }
  const user = c.get("user");
  const { newPassword } = await readJsonBody(c, setPasswordSchema);

  try {
    await getAuth().api.setPassword({
      body: { newPassword },
      headers: c.req.raw.headers,
    });
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "body" in err
        ? (err as { body?: { code?: string } }).body?.code
        : undefined;
    if (code === "PASSWORD_ALREADY_SET") {
      throw conflict(
        "password_already_set",
        "A password is already set for this account. Use the change password form instead.",
      );
    }
    logger.error("Failed to set password", {
      userId: user.id,
      error: getErrorMessage(err),
    });
    throw internalError();
  }

  return c.json({ status: true });
});

// POST /api/profiles/batch — batch lookup display names by user IDs (scoped to org members)
profileRouter.post("/profiles/batch", async (c) => {
  const orgId = c.get("orgId");
  const data = await readJsonBody(c, batchLookupSchema);
  const ids = data.ids.filter(Boolean);
  if (ids.length === 0) return c.json(listResponse([]));

  const rows = await db
    .select({ id: profiles.id, displayName: profiles.displayName })
    .from(profiles)
    .innerJoin(organizationMembers, eq(profiles.id, organizationMembers.userId))
    .where(scopedWhere(organizationMembers, { orgId, extra: [inArray(profiles.id, ids)] }));

  return c.json(listResponse(rows));
});

export default profileRouter;
