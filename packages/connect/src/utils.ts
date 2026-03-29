/**
 * Shared utilities for the connect package.
 */

import type { Actor } from "./types.ts";

/**
 * Extract a human-readable error message from an unknown error value.
 */
export function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reconstruct an Actor from DB row columns.
 * endUserId takes precedence; userId is guaranteed non-null when endUserId is null (DB check constraint).
 */
export function actorFromRow(row: { userId: string | null; endUserId: string | null }): Actor {
  return row.endUserId
    ? { type: "end_user", id: row.endUserId }
    : { type: "member", id: row.userId! };
}

/**
 * Convert an Actor to DB column values for userId/endUserId.
 */
export function actorToColumns(actor: Actor): { userId: string | null; endUserId: string | null } {
  return actor.type === "end_user"
    ? { userId: null, endUserId: actor.id }
    : { userId: actor.id, endUserId: null };
}
