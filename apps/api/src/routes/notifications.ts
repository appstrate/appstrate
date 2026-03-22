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
    const limit = Math.min(parseInt(c.req.query("limit") || "20", 10) || 20, 100);
    const offset = parseInt(c.req.query("offset") || "0", 10) || 0;
    const result = await listUserExecutions(actorId, orgId, { limit, offset });
    return c.json(result);
  });

  return router;
}
