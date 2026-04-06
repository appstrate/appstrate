// SPDX-License-Identifier: Apache-2.0

/**
 * End-Users API — CRUD for end-users.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { idempotency } from "../middleware/idempotency.ts";
import {
  createEndUser,
  listEndUsers,
  getEndUser,
  updateEndUser,
  deleteEndUser,
} from "../services/end-users.ts";
import { invalidRequest, notFound, parseBody } from "../lib/errors.ts";
import { requirePermission } from "../middleware/require-permission.ts";
const createEndUserSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
  externalId: z.string().optional(),
  metadata: z
    .record(
      z.string().min(1).max(40),
      z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
    )
    .refine((obj) => Object.keys(obj).length <= 50, "Maximum 50 metadata keys")
    .optional(),
});

const updateEndUserSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
  externalId: z.string().optional(),
  metadata: z
    .record(
      z.string().min(1).max(40),
      z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
    )
    .refine((obj) => Object.keys(obj).length <= 50, "Maximum 50 metadata keys")
    .optional(),
});

export function createEndUsersRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/end-users — create an end-user
  router.post(
    "/",
    rateLimit(60),
    idempotency(),
    requirePermission("end-users", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const body = await c.req.json();
      const data = parseBody(createEndUserSchema, body);

      const appId = c.get("applicationId");
      const created = await createEndUser(orgId, appId, {
        name: data.name,
        email: data.email,
        externalId: data.externalId,
        metadata: data.metadata,
      });
      return c.json(created, 201);
    },
  );

  // GET /api/end-users — list end-users in the org (cursor-based pagination)
  router.get("/", rateLimit(300), async (c) => {
    const orgId = c.get("orgId");
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
    const startingAfter = c.req.query("startingAfter");
    const endingBefore = c.req.query("endingBefore");
    const applicationId = c.get("applicationId");
    const externalId = c.req.query("externalId");
    const email = c.req.query("email");

    if (startingAfter && endingBefore) {
      throw invalidRequest("startingAfter and endingBefore are mutually exclusive");
    }

    const result = await listEndUsers(orgId, {
      applicationId,
      externalId: externalId ?? undefined,
      email: email ?? undefined,
      limit,
      startingAfter: startingAfter ?? undefined,
      endingBefore: endingBefore ?? undefined,
    });

    return c.json(result);
  });

  // GET /api/end-users/:id — get a single end-user
  router.get("/:id", rateLimit(300), async (c) => {
    const orgId = c.get("orgId");
    const appId = c.get("applicationId");
    const endUserId = c.req.param("id")!;
    const result = await getEndUser(orgId, endUserId);
    if (result.applicationId !== appId) {
      throw notFound(`End-user '${endUserId}' not found`);
    }
    return c.json(result);
  });

  // PATCH /api/end-users/:id — update an end-user
  router.patch("/:id", rateLimit(60), requirePermission("end-users", "write"), async (c) => {
    const orgId = c.get("orgId");
    const appId = c.get("applicationId");
    const endUserId = c.req.param("id")!;

    // Verify end-user belongs to the current application
    const existing = await getEndUser(orgId, endUserId);
    if (existing.applicationId !== appId) {
      throw notFound(`End-user '${endUserId}' not found`);
    }

    const body = await c.req.json();
    const data = parseBody(updateEndUserSchema, body);
    const result = await updateEndUser(orgId, endUserId, data);
    return c.json(result);
  });

  // DELETE /api/end-users/:id — delete an end-user and all connections
  router.delete("/:id", rateLimit(60), requirePermission("end-users", "delete"), async (c) => {
    const orgId = c.get("orgId");
    const appId = c.get("applicationId");
    const endUserId = c.req.param("id")!;

    // Verify end-user belongs to the current application
    const existing = await getEndUser(orgId, endUserId);
    if (existing.applicationId !== appId) {
      throw notFound(`End-user '${endUserId}' not found`);
    }

    await deleteEndUser(orgId, endUserId);
    return c.body(null, 204);
  });

  return router;
}
