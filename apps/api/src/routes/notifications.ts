import { z } from "zod";
import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { getActor } from "../lib/actor.ts";
import {
  getUnreadNotificationCount,
  getUnreadCountsByFlow,
  markNotificationRead,
  markAllNotificationsRead,
  listUserExecutions,
  listOrgExecutions,
} from "../services/state/index.ts";

export function createNotificationsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/notifications/unread-count
  router.get("/notifications/unread-count", async (c) => {
    const actor = getActor(c);
    const orgId = c.get("orgId");
    const count = await getUnreadNotificationCount(actor.id, orgId);
    return c.json({ count });
  });

  // GET /api/notifications/unread-counts-by-flow
  router.get("/notifications/unread-counts-by-flow", async (c) => {
    const actor = getActor(c);
    const orgId = c.get("orgId");
    const counts = await getUnreadCountsByFlow(actor.id, orgId);
    return c.json({ counts });
  });

  // PUT /api/notifications/read/:executionId
  router.put("/notifications/read/:executionId", async (c) => {
    const actor = getActor(c);
    const orgId = c.get("orgId");
    const executionId = c.req.param("executionId");
    const ok = await markNotificationRead(executionId, actor.id, orgId);
    return c.json({ ok });
  });

  // PUT /api/notifications/read-all
  router.put("/notifications/read-all", async (c) => {
    const actor = getActor(c);
    const orgId = c.get("orgId");
    const updated = await markAllNotificationsRead(actor.id, orgId);
    return c.json({ updated });
  });

  // GET /api/executions (org executions, optionally filtered by ?user=me)
  router.get("/executions", async (c) => {
    const actor = getActor(c);
    const orgId = c.get("orgId");
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .catch(20)
      .parse(c.req.query("limit") ?? 20);
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .catch(0)
      .parse(c.req.query("offset") ?? 0);
    const userFilter = c.req.query("user");
    const endUser = c.get("endUser");

    // End-users always see only their own executions
    const result =
      userFilter === "me" || endUser
        ? await listUserExecutions(actor.id, orgId, { limit, offset })
        : await listOrgExecutions(orgId, { limit, offset });
    return c.json(result);
  });

  return router;
}
