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
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { forbidden, invalidRequest, notFound } from "../lib/errors.ts";
import { isPlatformAdmin } from "@appstrate/db/auth-policy";
import { listStorageDeletionJobs, retryStorageDeletionJob } from "../services/storage-deletion.ts";

/** Reject anyone who is not an authenticated platform admin (session-authed). */
function requirePlatformAdmin(c: Context<AppEnv>): void {
  const user = c.get("user");
  if (!user || c.get("authMethod") === "api_key" || !isPlatformAdmin(user.email)) {
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

  router.get("/", async (c) => {
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

  router.post("/:id/retry", async (c) => {
    requirePlatformAdmin(c);
    const id = c.req.param("id");
    const retried = await retryStorageDeletionJob(id);
    if (!retried) throw notFound("Storage deletion job not found or already completed");
    return c.json({ id, retried: true });
  });

  return router;
}
