import { z } from "zod";
import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  getUnreadNotificationCount,
  getUnreadCountsByFlow,
  markNotificationRead,
  markAllNotificationsRead,
  listUserExecutions,
} from "../services/state/index.ts";

export function createNotificationsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/notifications/unread-count
  router.get("/notifications/unread-count", async (c) => {
    const user = c.get("user");
    const endUser = c.get("endUser");
    const orgId = c.get("orgId");
    const actorId = endUser ? endUser.id : user.id;
    const count = await getUnreadNotificationCount(actorId, orgId);
    return c.json({ count });
  });

  // GET /api/notifications/unread-counts-by-flow
  router.get("/notifications/unread-counts-by-flow", async (c) => {
    const user = c.get("user");
    const endUser = c.get("endUser");
    const orgId = c.get("orgId");
    const actorId = endUser ? endUser.id : user.id;
    const counts = await getUnreadCountsByFlow(actorId, orgId);
    return c.json({ counts });
  });

  // PUT /api/notifications/read/:executionId
  router.put("/notifications/read/:executionId", async (c) => {
    const user = c.get("user");
    const endUser = c.get("endUser");
    const orgId = c.get("orgId");
    const actorId = endUser ? endUser.id : user.id;
    const executionId = c.req.param("executionId");
    const ok = await markNotificationRead(executionId, actorId, orgId);
    return c.json({ ok });
  });

  // PUT /api/notifications/read-all
  router.put("/notifications/read-all", async (c) => {
    const user = c.get("user");
    const endUser = c.get("endUser");
    const orgId = c.get("orgId");
    const actorId = endUser ? endUser.id : user.id;
    const updated = await markAllNotificationsRead(actorId, orgId);
    return c.json({ updated });
  });

  // GET /api/executions (all user executions across flows)
  router.get("/executions", async (c) => {
    const user = c.get("user");
    const endUser = c.get("endUser");
    const orgId = c.get("orgId");
    const actorId = endUser ? endUser.id : user.id;
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
    const result = await listUserExecutions(actorId, orgId, { limit, offset });
    return c.json(result);
  });

  return router;
}
