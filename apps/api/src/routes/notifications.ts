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
} from "../services/state/notifications.ts";
import { notFound } from "../lib/errors.ts";
import { getAppScope } from "../lib/scope.ts";
import { setCursorLinkHeader } from "../lib/pagination-link.ts";

export function createNotificationsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/notifications — recipient-scoped feed, newest first.
  // Keyset-paginated: `?startingAfter=<id>` follows the `Link: rel="next"`
  // cursor (Stripe-style). `?unread=true` filters to unread only.
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
    const startingAfter = c.req.query("startingAfter");
    const result = await listNotifications(scope, actor, { unread, limit, startingAfter });
    const lastId = result.data.at(-1)?.id;
    setCursorLinkHeader({ c, hasMore: result.has_more, lastId });
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
  // run read, keyed by run id. First-class convenience for callers that hold a
  // run id but not the notification id (the run-detail page marks the run's
  // notification read on open). Complements PUT /notifications/:id/read.
  // Idempotent 204 — a missing run or non-recipient is a no-op, not a 404.
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

  return router;
}
