/**
 * Users API — CRUD for API-created users.
 * All routes require API key auth (admin).
 * No Appstrate-User header on these routes (admin manages users directly).
 */

import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { requireAdmin } from "../middleware/guards.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import {
  createUser,
  listUsers,
  getUser,
  updateUser,
  deleteUser,
  validateMetadata,
} from "../services/users.ts";
import { invalidRequest } from "../lib/errors.ts";

export function createUsersRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/users — create a user
  router.post("/", rateLimit(60), requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const body = await c.req.json<{
      name?: string;
      email?: string;
      externalId?: string;
      metadata?: Record<string, string>;
    }>();

    if (body.metadata !== undefined) {
      const result = validateMetadata(body.metadata);
      if (!result.valid) {
        throw invalidRequest(result.message, "metadata");
      }
    }

    const created = await createUser(orgId, body);
    return c.json(created, 201);
  });

  // GET /api/users — list users in the org (cursor-based pagination)
  router.get("/", rateLimit(300), requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
    const startingAfter = c.req.query("startingAfter");
    const endingBefore = c.req.query("endingBefore");
    const externalId = c.req.query("externalId");
    const email = c.req.query("email");

    if (startingAfter && endingBefore) {
      throw invalidRequest("startingAfter and endingBefore are mutually exclusive");
    }

    const result = await listUsers(orgId, {
      limit,
      startingAfter: startingAfter ?? undefined,
      endingBefore: endingBefore ?? undefined,
      externalId: externalId ?? undefined,
      email: email ?? undefined,
    });

    return c.json(result);
  });

  // GET /api/users/:id — get a single user
  router.get("/:id", rateLimit(300), requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const userId = c.req.param("id")!;
    const result = await getUser(orgId, userId);
    return c.json(result);
  });

  // PATCH /api/users/:id — update a user
  router.patch("/:id", rateLimit(60), requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const userId = c.req.param("id")!;
    const body = await c.req.json<{
      name?: string;
      email?: string;
      externalId?: string | null;
      metadata?: Record<string, string>;
    }>();

    if (body.metadata !== undefined) {
      const result = validateMetadata(body.metadata);
      if (!result.valid) {
        throw invalidRequest(result.message, "metadata");
      }
    }

    const result = await updateUser(orgId, userId, body);
    return c.json(result);
  });

  // DELETE /api/users/:id — delete a user and all connections
  router.delete("/:id", rateLimit(60), requireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const userId = c.req.param("id")!;
    await deleteUser(orgId, userId);
    return c.body(null, 204);
  });

  return router;
}
