// SPDX-License-Identifier: Apache-2.0

import type { BrowserProviderId } from "@appstrate/core/sidecar-types";
import { db } from "@appstrate/db/client";
import { browserProfileDeletions } from "@appstrate/db/schema";
import { and, eq, lte, sql } from "drizzle-orm";

import {
  createBrowserProfileManager,
  type BrowserProfileManager,
} from "./browser-profile-manager.ts";

export async function enqueueBrowserProfileDeletion(
  provider: BrowserProviderId,
  profileRef: string,
): Promise<void> {
  await db
    .insert(browserProfileDeletions)
    .values({ provider, profileRef })
    .onConflictDoNothing({
      target: [browserProfileDeletions.provider, browserProfileDeletions.profileRef],
    });
}

function retryDelayMs(attempts: number): number {
  return Math.min(24 * 60 * 60_000, 30_000 * 2 ** Math.min(attempts, 11));
}

export async function drainBrowserProfileDeletions(
  profileManager: BrowserProfileManager = createBrowserProfileManager(),
  options: { limit?: number; now?: Date } = {},
): Promise<{ removed: number; failed: number }> {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("browser profile deletion limit is outside the allowed range");
  }
  const now = options.now ?? new Date();
  const rows = await db
    .select()
    .from(browserProfileDeletions)
    .where(lte(browserProfileDeletions.nextAttemptAt, now))
    .orderBy(browserProfileDeletions.nextAttemptAt)
    .limit(limit);
  let removed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await profileManager.remove(row.provider as BrowserProviderId, row.profileRef);
      const deleted = await db
        .delete(browserProfileDeletions)
        .where(
          and(
            eq(browserProfileDeletions.id, row.id),
            eq(browserProfileDeletions.attempts, row.attempts),
          ),
        )
        .returning({ id: browserProfileDeletions.id });
      removed += deleted.length;
    } catch (error) {
      failed += 1;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      await db
        .update(browserProfileDeletions)
        .set({
          attempts: sql`${browserProfileDeletions.attempts} + 1`,
          nextAttemptAt: new Date(now.getTime() + retryDelayMs(row.attempts)),
          lastError: message,
          updatedAt: now,
        })
        .where(
          and(
            eq(browserProfileDeletions.id, row.id),
            eq(browserProfileDeletions.attempts, row.attempts),
          ),
        );
    }
  }
  return { removed, failed };
}

export const _test = { retryDelayMs };
