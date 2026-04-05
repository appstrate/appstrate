// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { getActor } from "../lib/actor.ts";
import {
  getUnreadNotificationCount,
  getUnreadCountsByAgent,
  markNotificationRead,
  markAllNotificationsRead,
  listUserRuns,
  listOrgRuns,
} from "../services/state/index.ts";
import { requireAppContext } from "../middleware/app-context.ts";

export function createNotificationsRouter() {
  const router = new Hono<AppEnv>();
  router.use("/notifications/*", requireAppContext());
  router.use("/runs", requireAppContext());
  router.use("/runs/*", requireAppContext());

  // GET /api/notifications/unread-count
  router.get("/notifications/unread-count", async (c) => {
    const actor = getActor(c);
    const orgId = c.get("orgId");
    const count = await getUnreadNotificationCount(actor.id, orgId, c.get("applicationId"));
    return c.json({ count });
  });

  // GET /api/notifications/unread-counts-by-agent
  router.get("/notifications/unread-counts-by-agent", async (c) => {
    const actor = getActor(c);
    const orgId = c.get("orgId");
    const counts = await getUnreadCountsByAgent(actor.id, orgId, c.get("applicationId"));
    return c.json({ counts });
  });

  // PUT /api/notifications/read/:runId
  router.put("/notifications/read/:runId", async (c) => {
    const actor = getActor(c);
    const orgId = c.get("orgId");
    const runId = c.req.param("runId");
    const ok = await markNotificationRead(runId, actor.id, orgId, c.get("applicationId"));
    return c.json({ ok });
  });

  // PUT /api/notifications/read-all
  router.put("/notifications/read-all", async (c) => {
    const actor = getActor(c);
    const orgId = c.get("orgId");
    const updated = await markAllNotificationsRead(actor.id, orgId, c.get("applicationId"));
    return c.json({ updated });
  });

  // GET /api/runs (org runs, optionally filtered by ?user=me)
  router.get("/runs", async (c) => {
    const actor = getActor(c);
    const orgId = c.get("orgId");
    const appId = c.get("applicationId");
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

    // End-users always see only their own runs
    const result =
      userFilter === "me" || endUser
        ? await listUserRuns(actor.id, orgId, { limit, offset, applicationId: appId })
        : await listOrgRuns(orgId, { limit, offset, applicationId: appId });
    return c.json(result);
  });

  return router;
}
