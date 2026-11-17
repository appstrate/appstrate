// SPDX-License-Identifier: Apache-2.0

import { Hono, type Context } from "hono";
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
  type FeedReach,
} from "../services/state/notifications.ts";
import { notFound } from "../lib/errors.ts";
import { getSpaceScope } from "../lib/scope.ts";
import { setCursorLinkHeader } from "../lib/pagination-link.ts";
import { parseListLimit } from "@appstrate/core/list-query";

/**
 * The feed's ceiling: the feed is the recipient's own, so no role grant is asked
 * (a share notice reaches a member who reads no run); a delegated credential is
 * capped by the run read (RBAC spec §7.1).
 */
export const NOTIFICATION_FEED_CEILING = RUNS_READ_PERMISSIONS;

/** The feed over `reach`: `GET /api/notifications` and `GET /api/orgs/{orgId}/notifications`. */
export async function respondNotificationList(c: Context<AppEnv>, reach: FeedReach) {
  const unread = c.req.query("unread") === "true";
  // Keyset-paginated on `startingAfter`, so only the helper's `limit` applies.
  const limit = parseListLimit(c, { defaultLimit: 20 });
  const startingAfter = c.req.query("startingAfter");
  const result = await listNotifications(reach, getActor(c), { unread, limit, startingAfter });
  setCursorLinkHeader({ c, hasMore: result.hasMore, lastId: result.data.at(-1)?.id });
  return c.json(result);
}

/** The unread count over `reach`: the bell's badge, of one space or of every reached one. */
export async function respondUnreadNotificationCount(c: Context<AppEnv>, reach: FeedReach) {
  return c.json({ count: await getUnreadNotificationCount(reach, getActor(c)) });
}

/** The space route's reach: the request's space. */
function spaceReach(c: Context<AppEnv>): FeedReach {
  const { orgId, spaceId } = getSpaceScope(c);
  return { orgId, spaceIds: [spaceId] };
}

/**
 * The recipient's notification feed — the dashboard bell: what needs their
 * attention (a failed run, an agent's message, a share). A notification is read
 * by the page it opens: a `run_failed` by its run (`PUT /api/runs/{id}/read`),
 * every other kind by its own page (`PUT /api/notifications/{id}/read`).
 */
export function createNotificationsRouter() {
  const router = new Hono<AppEnv>();
  const feedCeiling = requireAnyCeiling(NOTIFICATION_FEED_CEILING);

  // GET /api/notifications — recipient-scoped feed, newest first.
  // Keyset-paginated: `?startingAfter=<id>` follows the `Link: rel="next"`
  // cursor (Stripe-style). `?unread=true` filters to unread only.
  router.get("/notifications", feedCeiling, (c) => respondNotificationList(c, spaceReach(c)));

  // GET /api/notifications/unread-count
  router.get("/notifications/unread-count", feedCeiling, (c) =>
    respondUnreadNotificationCount(c, spaceReach(c)),
  );

  // GET /api/notifications/:id — a pure read; the notification's page marks it
  // read through the PUT below.
  router.get("/notifications/:id", feedCeiling, async (c) => {
    const notification = await getNotification(getSpaceScope(c), c.req.param("id")!, getActor(c));
    if (!notification) throw notFound("Notification not found");
    return c.json(notification);
  });

  // PUT /api/notifications/:id/read
  router.put("/notifications/:id/read", feedCeiling, async (c) => {
    // Idempotent for the recipient (204 whether it was unread or already
    // read); 404 when the notification isn't the caller's — no silent no-op
    // for non-recipients.
    const ok = await markNotificationRead(getSpaceScope(c), c.req.param("id")!, getActor(c));
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
