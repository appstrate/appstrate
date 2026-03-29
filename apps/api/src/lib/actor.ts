import type { Context } from "hono";
import { eq } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import type { Actor } from "@appstrate/connect";

export type { Actor };

/** Résout l'acteur depuis le contexte Hono. */
export function getActor(c: Context): Actor {
  const endUser = c.get("endUser");
  if (endUser) return { type: "end_user", id: endUser.id };
  return { type: "member", id: c.get("user").id };
}

/** Produit les colonnes {userId, endUserId} pour un INSERT. */
export function actorInsert(actor: Actor): {
  userId: string | null;
  endUserId: string | null;
} {
  return {
    userId: actor.type === "member" ? actor.id : null,
    endUserId: actor.type === "end_user" ? actor.id : null,
  };
}

/** Reconstruit un Actor à partir de colonnes userId/endUserId nullable. */
export function actorFromIds(userId: string | null, endUserId: string | null): Actor | null {
  if (userId) return { type: "member", id: userId };
  if (endUserId) return { type: "end_user", id: endUserId };
  return null;
}

/** Produit le WHERE clause pour filtrer par acteur. */
export function actorFilter(actor: Actor, cols: { userId: Column; endUserId: Column }) {
  return actor.type === "end_user" ? eq(cols.endUserId, actor.id) : eq(cols.userId, actor.id);
}
