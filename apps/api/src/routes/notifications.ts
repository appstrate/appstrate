// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { getActor } from "../lib/actor.ts";
import {
  getUnreadNotificationCount,
  getUnreadCountsByAgent,
  markNotificationRead,
  markNotificationReadByRun,
  markAllNotificationsRead,
  listNotifications,
  listUserRuns,
} from "../services/state/notifications.ts";
import { listGlobalRuns, type GlobalRunKind } from "../services/state/runs.ts";
import { invalidRequest, notFound } from "../lib/errors.ts";
import { getAppScope } from "../lib/scope.ts";
import { setOffsetLinkHeader } from "../lib/pagination-link.ts";

export function createNotificationsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/notifications — paginated list for the current recipient.
  // `?unread=true` filters to unread only.
  router.get("/notifications", async (c) => {
    const actor = getActor(c);
    const scope = getAppScope(c);
    const unread = c.req.query("unread") === "true";
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
    const result = await listNotifications(scope, actor, { unread, limit, offset });
    setOffsetLinkHeader({ c, limit, offset, total: result.total });
    return c.json(result);
  });

  // GET /api/notifications/unread-count
  router.get("/notifications/unread-count", async (c) => {
    const actor = getActor(c);
    const scope = getAppScope(c);
    const count = await getUnreadNotificationCount(scope, actor);
    return c.json({ count });
  });

  // GET /api/notifications/unread-counts-by-agent
  router.get("/notifications/unread-counts-by-agent", async (c) => {
    const actor = getActor(c);
    const scope = getAppScope(c);
    const counts = await getUnreadCountsByAgent(scope, actor);
    return c.json({ counts });
  });

  // PUT /api/notifications/:id/read
  router.put("/notifications/:id/read", async (c) => {
    const actor = getActor(c);
    const scope = getAppScope(c);
    const id = c.req.param("id");
    // Idempotent for the recipient (204 whether it was unread or already
    // read); 404 when the notification isn't the caller's — no silent no-op
    // for non-recipients (issue #667).
    const ok = await markNotificationRead(scope, id, actor);
    if (!ok) throw notFound("Notification not found");
    return c.body(null, 204);
  });

  // PUT /api/notifications/read/:runId — mark the caller's notification for a
  // run read, keyed by run id (the run-detail page holds the run id, not the
  // notification id). Complements PUT /notifications/:id/read. Idempotent 204
  // — a missing run or non-recipient is a no-op, not a 404.
  router.put("/notifications/read/:runId", async (c) => {
    const actor = getActor(c);
    const scope = getAppScope(c);
    const runId = c.req.param("runId");
    await markNotificationReadByRun(scope, runId, actor);
    return c.body(null, 204);
  });

  // PUT /api/notifications/read-all — bulk mutation: returns a documented
  // operation result ({ updated_count }), not a resource (issue #657).
  router.put("/notifications/read-all", async (c) => {
    const actor = getActor(c);
    const scope = getAppScope(c);
    const updated = await markAllNotificationsRead(scope, actor);
    return c.json({ updated_count: updated });
  });

  // GET /api/runs — global paginated run list across the application.
  // Supports filtering by ?user=me (self-owned runs), ?kind=inline|package|all
  // for inline-run filtering, ?status, ?start_date/?end_date.
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
      const result = await listUserRuns(scope, actor, { limit, offset });
      setOffsetLinkHeader({ c, limit, offset, total: result.total });
      return c.json(result);
    }

    const rawKind = c.req.query("kind");
    const kind: GlobalRunKind | undefined =
      rawKind === "inline" || rawKind === "package" || rawKind === "all"
        ? (rawKind as GlobalRunKind)
        : undefined;
    const status = c.req.query("status");
    const startDateRaw = c.req.query("start_date");
    const endDateRaw = c.req.query("end_date");
    const startDate = startDateRaw ? new Date(startDateRaw) : undefined;
    const endDate = endDateRaw ? new Date(endDateRaw) : undefined;
    if (startDate && Number.isNaN(startDate.getTime())) {
      throw invalidRequest("start_date is not a valid ISO date", "start_date");
    }
    if (endDate && Number.isNaN(endDate.getTime())) {
      throw invalidRequest("end_date is not a valid ISO date", "end_date");
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
