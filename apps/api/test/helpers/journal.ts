// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = resolve(import.meta.dir, "../../../../packages/db/drizzle");

/**
 * Replay the platform journal onto a private PGlite the way the Tier 0 runner
 * does (`apps/api/src/lib/pglite-migrate.ts`): whole file, breakpoints stripped,
 * one transaction each. With `lastTag` it stops after that entry, and throws if
 * there is none, so a renamed migration fails the caller instead of silently
 * shortening the replay.
 */
export async function replayJournal(db: PGlite, lastTag?: string): Promise<void> {
  const journal = (await Bun.file(`${MIGRATIONS_DIR}/meta/_journal.json`).json()) as {
    entries: { tag: string }[];
  };
  for (const { tag } of journal.entries) {
    const source = await Bun.file(`${MIGRATIONS_DIR}/${tag}.sql`).text();
    await db.transaction(async (tx) => {
      await tx.exec(source.replaceAll("--> statement-breakpoint", ""));
    });
    if (tag === lastTag) return;
  }
  if (lastTag !== undefined) throw new Error(`journal has no entry tagged ${lastTag}`);
}
