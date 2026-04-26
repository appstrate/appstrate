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
import { invalidRequest, parseBody } from "../lib/errors.ts";
import { setCursorLinkHeader } from "../lib/pagination-link.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { getAppScope } from "../lib/scope.ts";

export const createEndUserSchema = z.object({
  name: z.string().max(200).nullable().optional(),
  email: z.string().email().nullable().optional(),
  externalId: z.string().max(255).nullable().optional(),
  metadata: z
    .record(
      z.string().min(1).max(40),
      z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
    )
    .refine((obj) => Object.keys(obj).length <= 50, "Maximum 50 metadata keys")
    .optional(),
});

export const updateEndUserSchema = z.object({
  name: z.string().max(200).nullable().optional(),
  email: z.string().email().nullable().optional(),
  externalId: z.string().max(255).nullable().optional(),
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
      const scope = getAppScope(c);
      const body = await c.req.json();
      const data = parseBody(createEndUserSchema, body);

      const created = await createEndUser(scope, {
        name: data.name ?? undefined,
        email: data.email ?? undefined,
        externalId: data.externalId ?? undefined,
        metadata: data.metadata,
      });
      await recordAuditFromContext(c, {
        action: "end_user.created",
        resourceType: "end_user",
        resourceId: created.id,
        after: {
          externalId: created.externalId,
          email: created.email,
        },
      });
      return c.json(created, 201);
    },
  );

  // GET /api/end-users — list end-users in the application (cursor-based pagination)
  router.get("/", rateLimit(300), async (c) => {
    const scope = getAppScope(c);
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
    const startingAfter = c.req.query("startingAfter");
    const endingBefore = c.req.query("endingBefore");
    const externalId = c.req.query("externalId");
    const email = c.req.query("email");

    if (startingAfter && endingBefore) {
      throw invalidRequest("startingAfter and endingBefore are mutually exclusive");
    }

    const result = await listEndUsers(scope, {
      externalId: externalId ?? undefined,
      email: email ?? undefined,
      limit,
      startingAfter: startingAfter ?? undefined,
      endingBefore: endingBefore ?? undefined,
    });

    setCursorLinkHeader({
      c,
      hasMore: result.hasMore,
      lastId: result.data[result.data.length - 1]?.id,
      firstId: result.data[0]?.id,
      hasPrev: Boolean(endingBefore || startingAfter),
    });

    return c.json(result);
  });

  // GET /api/end-users/:id — get a single end-user
  router.get("/:id", rateLimit(300), async (c) => {
    const scope = getAppScope(c);
    const endUserId = c.req.param("id")!;
    const result = await getEndUser(scope, endUserId);
    return c.json(result);
  });

  // PATCH /api/end-users/:id — update an end-user
  router.patch("/:id", rateLimit(60), requirePermission("end-users", "write"), async (c) => {
    const scope = getAppScope(c);
    const endUserId = c.req.param("id")!;

    const body = await c.req.json();
    const data = parseBody(updateEndUserSchema, body);
    const result = await updateEndUser(scope, endUserId, {
      name: data.name ?? undefined,
      email: data.email ?? undefined,
      externalId: data.externalId ?? undefined,
      metadata: data.metadata,
    });
    await recordAuditFromContext(c, {
      action: "end_user.updated",
      resourceType: "end_user",
      resourceId: endUserId,
      after: data as unknown as Record<string, unknown>,
    });
    return c.json(result);
  });

  // DELETE /api/end-users/:id — delete an end-user and all connections
  router.delete("/:id", rateLimit(60), requirePermission("end-users", "delete"), async (c) => {
    const scope = getAppScope(c);
    const endUserId = c.req.param("id")!;

    await deleteEndUser(scope, endUserId);
    await recordAuditFromContext(c, {
      action: "end_user.deleted",
      resourceType: "end_user",
      resourceId: endUserId,
    });
    return c.body(null, 204);
  });

  return router;
}
