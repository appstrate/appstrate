// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { RUNS_READ_PERMISSIONS } from "@appstrate/core/permissions";
import { getActor } from "../lib/actor.ts";
import { requireAnyCeiling } from "../middleware/require-permission.ts";
import {
  getNotification,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  listNotifications,
} from "../services/state/notifications.ts";
import { notFound } from "../lib/errors.ts";
import { isUuid } from "../lib/db-helpers.ts";
import { getSpaceScope } from "../lib/scope.ts";
import { setCursorLinkHeader } from "../lib/pagination-link.ts";
import { parseListLimit } from "@appstrate/core/list-query";

/**
 * The recipient's notification feed — the dashboard bell: what needs their
 * attention (a failed run, a message an agent sent, a share). A notification is
 * read by the page it opens: the run page for a `run_failed` (through the
 * run's read state, `PUT /api/runs/{id}/read`, `read-all`), the notification's
 * own page (`GET` + `PUT /api/notifications/{id}/read`) for every other kind.
 */
export function createNotificationsRouter() {
  const router = new Hono<AppEnv>();
  // The feed is the recipient's own, so no role grant is asked (a share
  // notice reaches a member who reads no run); a delegated credential is
  // capped by the run read (RBAC spec §7.1).
  const feedCeiling = requireAnyCeiling(RUNS_READ_PERMISSIONS);

  // GET /api/notifications — recipient-scoped feed, newest first.
  // Keyset-paginated: `?startingAfter=<id>` follows the `Link: rel="next"`
  // cursor (Stripe-style). `?unread=true` filters to unread only.
  router.get("/notifications", feedCeiling, async (c) => {
    const actor = getActor(c);
    const scope = getSpaceScope(c);
    const unread = c.req.query("unread") === "true";
    // Keyset-paginated on `startingAfter`, so only the helper's `limit` applies.
    const limit = parseListLimit(c, { defaultLimit: 20 });
    const startingAfter = c.req.query("startingAfter");
    const result = await listNotifications(scope, actor, { unread, limit, startingAfter });
    const lastId = result.data.at(-1)?.id;
    setCursorLinkHeader({ c, hasMore: result.hasMore, lastId });
    return c.json(result);
  });

  // GET /api/notifications/unread-count
  router.get("/notifications/unread-count", feedCeiling, async (c) => {
    const count = await getUnreadNotificationCount(getSpaceScope(c), getActor(c));
    return c.json({ count });
  });

  // GET /api/notifications/:id — one notification of the caller, read by the
  // page a notification opens. A pure read: that page marks it read through
  // the PUT below, the one door that reads a notification by its id. 404 when
  // it is not the caller's.
  router.get("/notifications/:id", feedCeiling, async (c) => {
    const id = c.req.param("id")!;
    // A non-uuid id names no notification: answer as for an unknown one rather
    // than letting the uuid column refuse it.
    const notification = isUuid(id)
      ? await getNotification(getSpaceScope(c), id, getActor(c))
      : null;
    if (!notification) throw notFound("Notification not found");
    return c.json(notification);
  });

  // PUT /api/notifications/:id/read
  router.put("/notifications/:id/read", feedCeiling, async (c) => {
    // Idempotent for the recipient (204 whether it was unread or already
    // read); 404 when the notification isn't the caller's — no silent no-op
    // for non-recipients.
    const id = c.req.param("id")!;
    const ok = isUuid(id) && (await markNotificationRead(getSpaceScope(c), id, getActor(c)));
    if (!ok) throw notFound("Notification not found");
    return c.body(null, 204);
  });

  // PUT /api/notifications/read-all — bulk mutation: returns a documented
  // operation result ({ updated_count }), not a resource.
  router.put("/notifications/read-all", feedCeiling, async (c) => {
    const updated = await markAllNotificationsRead(getSpaceScope(c), getActor(c));
    return c.json({ updated_count: updated });
  });

  return router;
}
