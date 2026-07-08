// SPDX-License-Identifier: Apache-2.0

/**
 * Profile service — the dashboard user's own identity record.
 *
 * The display name is mirrored across two tables that must stay in sync:
 *   - `profiles.displayName` — the platform-owned profile row.
 *   - Better Auth-owned `user.name` — the authoritative account name surfaced
 *     by Better Auth sessions and the CLI's `whoami`.
 *
 * Both `PATCH /api/profile` and `POST /api/welcome/setup` perform this
 * dual-write, so it lives here as a single source of truth. Callers keep
 * their own `api_key` guard (an API key must never rename the dashboard
 * owner); this service only owns the persistence mechanics.
 */

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { profiles, user as userTable } from "@appstrate/db/schema";

/**
 * Write a trimmed display name to BOTH `profiles.displayName` and the
 * Better Auth-owned `user.name`, keeping the two in sync. Wrapped in a single
 * transaction so the mirror is all-or-nothing: if the second update fails the
 * first rolls back, and the two tables never diverge (the previous
 * `Promise.all` of two independent statements could leave `profiles` updated
 * while `user.name` stayed stale on a partial failure). Both stamp `updatedAt`.
 */
export async function setDisplayName(userId: string, displayName: string): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(profiles).set({ displayName, updatedAt: now }).where(eq(profiles.id, userId));
    await tx
      .update(userTable)
      .set({ name: displayName, updatedAt: now })
      .where(eq(userTable.id, userId));
  });
}
