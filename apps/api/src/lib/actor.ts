// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { and, eq, isNull, or } from "drizzle-orm";
import type { Column, SQL } from "drizzle-orm";
import type { Actor } from "@appstrate/connect";

export type { Actor };

/** Resolves the actor from the Hono context. */
export function getActor(c: Context): Actor {
  const endUser = c.get("endUser");
  if (endUser) return { type: "end_user", id: endUser.id };
  return { type: "user", id: c.get("user").id };
}

/**
 * Like {@link getActor} but returns `undefined` when NEITHER an end-user nor a
 * dashboard/API-key user is present in the context, instead of throwing. For
 * call sites where a principal is expected in production (every authenticated
 * route) but the identity is used only for a best-effort ownership scoping that
 * degrades safely to tenant-only when absent.
 */
export function tryGetActor(c: Context): Actor | undefined {
  const endUser = c.get("endUser");
  if (endUser) return { type: "end_user", id: endUser.id };
  const user = c.get("user");
  return user ? { type: "user", id: user.id } : undefined;
}

/**
 * Produces the `{userId, endUserId}` column pair for an INSERT. Both `runs`
 * and `integration_connections` use those exact column names, so callers can
 * spread the result into the values object directly without further mapping.
 */
export function actorInsert(actor: Actor): {
  userId: string | null;
  endUserId: string | null;
} {
  return {
    userId: actor.type === "user" ? actor.id : null,
    endUserId: actor.type === "end_user" ? actor.id : null,
  };
}

/** Reconstructs an Actor from nullable userId/endUserId columns. */
export function actorFromIds(userId: string | null, endUserId: string | null): Actor | null {
  if (userId) return { type: "user", id: userId };
  if (endUserId) return { type: "end_user", id: endUserId };
  return null;
}

/**
 * Produces the WHERE clause to filter by actor. Pass the `{userId, endUserId}`
 * column pair from whichever table is being scoped (e.g. `runs.userId` /
 * `runs.endUserId`, or `integrationConnections.userId` / `endUserId`).
 */
export function actorFilter(actor: Actor, cols: { userId: Column; endUserId: Column }) {
  return actor.type === "end_user" ? eq(cols.endUserId, actor.id) : eq(cols.userId, actor.id);
}

/**
 * WHERE clause matching a polymorphic actor against a `{typeCol, idCol}`
 * pair — the generic counterpart to {@link actorFilter} for tables that
 * store the recipient as `(type, id)` (e.g. `notifications`). Both columns
 * are matched, so correctness does not rest on the assumption that user ids
 * and end-user ids never collide.
 */
export function actorMatch(actor: Actor, cols: { typeCol: Column; idCol: Column }): SQL {
  return and(eq(cols.typeCol, actor.type), eq(cols.idCol, actor.id))!;
}

/**
 * WHERE clause for "my runs"-style list/visibility views that must respect the
 * actor boundary. Dashboard members (`type: "user"`) see their own rows PLUS
 * org-visible rows with no dashboard owner (schedule/system-triggered, where
 * `userId IS NULL`). End-users (`type: "end_user"`) see ONLY their own rows —
 * they must never observe another end-user's or a system-triggered row.
 *
 * The `isNull(userId)` branch is therefore gated to the `user` actor: for an
 * `end_user` actor it collapses to strict ownership, because every
 * end-user-triggered row is written with `userId NULL` (see {@link actorInsert})
 * — so an unconditional `isNull(userId)` would match every other end-user's and
 * every system row. This is the single canonical helper for that semantic; do
 * not re-derive the `or(ownership, isNull(userId))` pattern inline.
 */
export function actorScopeFilter(actor: Actor, cols: { userId: Column; endUserId: Column }): SQL {
  const ownership = actorFilter(actor, cols);
  if (actor.type === "end_user") return ownership;
  return or(ownership, isNull(cols.userId))!;
}
