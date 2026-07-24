// SPDX-License-Identifier: Apache-2.0

/**
 * Operator surface for the transactional storage-deletion outbox
 * (`storage_deletion_jobs`). Gated by the platform-admin allowlist
 * (`AUTH_PLATFORM_ADMIN_EMAILS`) — there is no org-scoped admin route family,
 * and these jobs are instance-global (they outlive the org/app that created
 * them), so platform-admin is the correct boundary.
 *
 *   GET  /api/admin/storage-deletion-jobs?status=pending|dead|completed
 *   POST /api/admin/storage-deletion-jobs/:id/retry
 *
 * `dead` = pending jobs past the dead-letter attempt threshold (still retrying;
 * the threshold is a visibility line, not an abandon point).
 *
 * The listing is deliberately CROSS-ORG (bucket + in-bucket key, which encodes
 * the owning application id and the stored filename). That is the instance
 * operator's job — but it is also why the guard below is the strictest in the
 * codebase and why both routes are rate-limited.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { forbidden, invalidRequest, notFound } from "../lib/errors.ts";
import { isPlatformAdmin } from "@appstrate/db/auth-policy";
import { rateLimit } from "../middleware/rate-limit.ts";
import { listStorageDeletionJobs, retryStorageDeletionJob } from "../services/storage-deletion.ts";

/**
 * Reject anyone who is not an authenticated platform operator.
 *
 * Three independent conditions, ALL required — the allowlisted email alone is
 * not an authorization:
 *
 *  1. `authMethod === "session"` — an authentic first-party dashboard cookie
 *     session. Excluding only `"api_key"` was not enough: the OIDC strategy
 *     resolves `authMethod: "oauth2-dashboard"` / `"oauth2-instance"` with
 *     permissions derived from the token's scopes, so a token minted with a
 *     single trivial scope used to walk straight through this guard and read
 *     the cross-org outbox. An allowlist is a *who*, never a *how*.
 *  2. `sessionRealm === "platform"` — the Better Auth `user` table is shared
 *     with third-party application end-users, whose `email` is self-declared
 *     at signup. Without the realm check, an end-user who signs up with an
 *     allowlisted operator's address becomes a platform admin. The global
 *     `requirePlatformRealm` middleware already enforces this for session
 *     auth; re-asserting it here keeps the guard true on its own terms rather
 *     than by mounting order.
 *  3. `isPlatformAdmin(user.email)` — membership in
 *     `AUTH_PLATFORM_ADMIN_EMAILS`.
 */
function requirePlatformAdmin(c: Context<AppEnv>): void {
  const user = c.get("user");
  const isPlatformSession =
    c.get("authMethod") === "session" && c.get("sessionRealm") === "platform";
  if (!user || !isPlatformSession || !isPlatformAdmin(user.email)) {
    throw forbidden("Platform admin access required");
  }
}

const listQuerySchema = z.object({
  status: z.enum(["pending", "dead", "completed"]).default("pending"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export function createAdminStorageDeletionRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // Rate-limited like every other authenticated route (keyed on the operator's
  // identity): the guard is a hard 403, but an unbounded admin surface is still
  // an unbounded cross-org read for whoever holds a valid operator session.
  router.get("/", rateLimit(60), async (c) => {
    requirePlatformAdmin(c);
    const parsed = listQuerySchema.safeParse({
      status: c.req.query("status"),
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
    });
    if (!parsed.success) throw invalidRequest("Invalid query parameters");
    const result = await listStorageDeletionJobs(parsed.data);
    return c.json(result);
  });

  router.post("/:id/retry", rateLimit(30), async (c) => {
    requirePlatformAdmin(c);
    const id = c.req.param("id")!;
    const retried = await retryStorageDeletionJob(id);
    if (!retried) throw notFound("Storage deletion job not found or already completed");
    return c.json({ id, retried: true });
  });

  return router;
}
