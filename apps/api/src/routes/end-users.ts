/**
 * End-Users API — CRUD for end-users.
 * All routes require API key auth (admin).
 */

import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { requireAdmin } from "../middleware/guards.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import {
  createEndUser,
  listEndUsers,
  getEndUser,
  updateEndUser,
  deleteEndUser,
  validateMetadata,
} from "../services/end-users.ts";
import { invalidRequest } from "../lib/errors.ts";

export function createEndUsersRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/end-users — create an end-user
  router.post("/", rateLimit(60), requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json<{
      applicationId?: string;
      name?: string;
      email?: string;
      externalId?: string;
      metadata?: Record<string, unknown>;
    }>();

    if (body.metadata !== undefined) {
      const result = validateMetadata(body.metadata);
      if (!result.valid) {
        throw invalidRequest(result.message, "metadata");
      }
    }

    const created = await createEndUser(orgId, body.applicationId ?? null, {
      name: body.name,
      email: body.email,
      externalId: body.externalId,
      metadata: body.metadata,
    });
    return c.json(created, 201);
  });

  // GET /api/end-users — list end-users in the org (cursor-based pagination)
  router.get("/", rateLimit(300), requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
    const startingAfter = c.req.query("startingAfter");
    const endingBefore = c.req.query("endingBefore");
    const applicationId = c.req.query("applicationId");
    const externalId = c.req.query("externalId");
    const email = c.req.query("email");

    if (startingAfter && endingBefore) {
      throw invalidRequest("startingAfter and endingBefore are mutually exclusive");
    }

    const result = await listEndUsers(orgId, {
      applicationId: applicationId ?? undefined,
      externalId: externalId ?? undefined,
      email: email ?? undefined,
      limit,
      startingAfter: startingAfter ?? undefined,
      endingBefore: endingBefore ?? undefined,
    });

    return c.json(result);
  });

  // GET /api/end-users/:id — get a single end-user
  router.get("/:id", rateLimit(300), requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const endUserId = c.req.param("id")!;
    const result = await getEndUser(orgId, endUserId);
    return c.json(result);
  });

  // PATCH /api/end-users/:id — update an end-user
  router.patch("/:id", rateLimit(60), requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const endUserId = c.req.param("id")!;
    const body = await c.req.json<{
      name?: string;
      email?: string;
      externalId?: string;
      metadata?: Record<string, unknown>;
    }>();

    if (body.metadata !== undefined) {
      const result = validateMetadata(body.metadata);
      if (!result.valid) {
        throw invalidRequest(result.message, "metadata");
      }
    }

    const result = await updateEndUser(orgId, endUserId, body);
    return c.json(result);
  });

  // DELETE /api/end-users/:id — delete an end-user and all connections
  router.delete("/:id", rateLimit(60), requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const endUserId = c.req.param("id")!;
    await deleteEndUser(orgId, endUserId);
    return c.body(null, 204);
  });

  return router;
}
