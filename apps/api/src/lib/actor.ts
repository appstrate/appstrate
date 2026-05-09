// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { eq } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import type { Actor } from "@appstrate/connect";

export type { Actor };

/** Resolves the actor from the Hono context. */
export function getActor(c: Context): Actor {
  const endUser = c.get("endUser");
  if (endUser) return { type: "end_user", id: endUser.id };
  return { type: "user", id: c.get("user").id };
}

/**
 * Produces the `{userId, endUserId}` column pair for an INSERT. Both `runs`
 * and `connection_profiles` use those exact column names, so callers can
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
 * `runs.endUserId`, or `connectionProfiles.userId` / `endUserId`).
 */
export function actorFilter(actor: Actor, cols: { userId: Column; endUserId: Column }) {
  return actor.type === "end_user" ? eq(cols.endUserId, actor.id) : eq(cols.userId, actor.id);
}
