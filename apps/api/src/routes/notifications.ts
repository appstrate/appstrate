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
} from "../services/state/notifications.ts";
import { listGlobalRuns, type GlobalRunKind } from "../services/state/runs.ts";
import { invalidRequest } from "../lib/errors.ts";
import { getAppScope } from "../lib/scope.ts";
import { setOffsetLinkHeader } from "../lib/pagination-link.ts";

export function createNotificationsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/notifications/unread-count
  router.get("/notifications/unread-count", async (c) => {
    const actor = getActor(c);
    const scope = getAppScope(c);
    const count = await getUnreadNotificationCount(scope, actor.id);
    return c.json({ count });
  });

  // GET /api/notifications/unread-counts-by-agent
  router.get("/notifications/unread-counts-by-agent", async (c) => {
    const actor = getActor(c);
    const scope = getAppScope(c);
    const counts = await getUnreadCountsByAgent(scope, actor.id);
    return c.json({ counts });
  });

  // PUT /api/notifications/read/:runId
  router.put("/notifications/read/:runId", async (c) => {
    const actor = getActor(c);
    const scope = getAppScope(c);
    const runId = c.req.param("runId");
    const ok = await markNotificationRead(scope, runId, actor.id);
    return c.json({ ok });
  });

  // PUT /api/notifications/read-all
  router.put("/notifications/read-all", async (c) => {
    const actor = getActor(c);
    const scope = getAppScope(c);
    const updated = await markAllNotificationsRead(scope, actor.id);
    return c.json({ updated });
  });

  // GET /api/runs — global paginated run list across the application.
  // Supports filtering by ?user=me (self-owned runs), ?kind=inline|package|all
  // for inline-run filtering, ?status, ?startDate/?endDate.
  router.get("/runs", async (c) => {
    const actor = getActor(c);
    const scope = getAppScope(c);
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

    // End-users always see only their own runs — same semantic as before.
    if (userFilter === "me" || endUser) {
      const result = await listUserRuns(scope, actor.id, { limit, offset });
      setOffsetLinkHeader({ c, limit, offset, total: result.total });
      return c.json(result);
    }

    const rawKind = c.req.query("kind");
    const kind: GlobalRunKind | undefined =
      rawKind === "inline" || rawKind === "package" || rawKind === "all"
        ? (rawKind as GlobalRunKind)
        : undefined;
    const status = c.req.query("status");
    const startDateRaw = c.req.query("startDate");
    const endDateRaw = c.req.query("endDate");
    const startDate = startDateRaw ? new Date(startDateRaw) : undefined;
    const endDate = endDateRaw ? new Date(endDateRaw) : undefined;
    if (startDate && Number.isNaN(startDate.getTime())) {
      throw invalidRequest("startDate is not a valid ISO date", "startDate");
    }
    if (endDate && Number.isNaN(endDate.getTime())) {
      throw invalidRequest("endDate is not a valid ISO date", "endDate");
    }

    const result = await listGlobalRuns(scope, {
      limit,
      offset,
      kind,
      status,
      startDate,
      endDate,
    });
    setOffsetLinkHeader({ c, limit, offset, total: result.total });
    return c.json(result);
  });

  return router;
}
