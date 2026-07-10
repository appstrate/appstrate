// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end test for truncateAll()'s retry-on-deadlock behavior (issue #883).
 *
 * The flake this guards against: truncateAll()'s single-transaction DO block
 * takes row locks across every table while a previous test's fire-and-forget
 * work is still writing — a lock cycle Postgres breaks with SQLSTATE 40P01
 * after `deadlock_timeout`, failing whichever test happened to be cleaning up.
 *
 * This test manufactures that cycle deterministically instead of hoping for
 * load: a background transaction locks an `organizations` row (step 1), and
 * once truncateAll() is blocked on it, touches an `applications` row the
 * truncate has already deleted uncommitted (step 2). Both sides then wait on
 * each other — the only exit is Postgres aborting one of them with a
 * deadlock. Whichever side is the victim, truncateAll() must come out clean:
 * either it won and the background transaction absorbed the 40P01, or it was
 * the victim and its retry ran against the then-quiesced database.
 *
 * Postgres-only: PGlite (tier0) is single-connection, so two concurrent
 * transactions — and therefore this deadlock — cannot exist there.
 */
import { it, expect, spyOn } from "bun:test";
import { sql } from "drizzle-orm";
import { db, truncateAll } from "../../helpers/db.ts";
import { isTransientLockError } from "../../helpers/deadlock-retry.ts";
import { describeRequiresPostgres } from "../../helpers/tier.ts";
import { organizations, applications } from "@appstrate/db/schema";

describeRequiresPostgres("truncateAll deadlock resilience (issue #883)", () => {
  it(
    "survives a concurrent transaction deadlocking with the truncate",
    async () => {
      await truncateAll();

      const [org] = await db
        .insert(organizations)
        .values({ name: "deadlock-test", slug: `deadlock-${crypto.randomUUID()}` })
        .returning();
      if (!org) throw new Error("failed to seed organization");
      const appId = `app_deadlock_${crypto.randomUUID().slice(0, 8)}`;
      await db.insert(applications).values({ id: appId, orgId: org.id, name: "deadlock-app" });

      const warnSpy = spyOn(console, "warn");
      try {
        // Background transaction, playing the part of a previous test's
        // unawaited fire-and-forget work.
        const background: Promise<"committed" | { err: unknown }> = db
          .transaction(async (tx) => {
            // Step 1 — lock the org row. truncateAll()'s DELETE FROM
            // organizations will block on this.
            await tx.execute(sql`SELECT id FROM ${organizations} WHERE id = ${org.id} FOR UPDATE`);
            // Give truncateAll() time to delete `applications` (uncommitted)
            // and block on our org-row lock.
            await Bun.sleep(400);
            // Step 2 — touch the applications row the truncate already
            // deleted uncommitted. Now each side waits on the other: a lock
            // cycle only the deadlock detector can break.
            await tx.execute(sql`UPDATE ${applications} SET name = 'poke' WHERE id = ${appId}`);
          })
          .then(
            () => "committed" as const,
            (err: unknown) => ({ err }),
          );

        // Start the truncate after the background transaction holds its lock.
        await Bun.sleep(50);
        const truncatePromise = truncateAll();

        // truncateAll() must resolve — victim or not.
        const [backgroundOutcome] = await Promise.all([background, truncatePromise]);

        const truncateRetried = warnSpy.mock.calls.some(
          (call) => typeof call[0] === "string" && call[0].includes("[truncateAll]"),
        );
        if (backgroundOutcome === "committed") {
          // Background won ⇒ the truncate was the deadlock victim and must
          // have recovered through a retry.
          expect(truncateRetried).toBe(true);
        } else {
          // Truncate won ⇒ the background transaction absorbed the abort,
          // and it must be the transient lock class our retry targets.
          expect(isTransientLockError(backgroundOutcome.err)).toBe(true);
        }
        // The cycle is structural — one side MUST have hit the deadlock.
        expect(truncateRetried || backgroundOutcome !== "committed").toBe(true);

        // Whatever the outcome, the database ends up clean.
        expect(await db.select({ id: organizations.id }).from(organizations)).toHaveLength(0);
        expect(await db.select({ id: applications.id }).from(applications)).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
      }
    },
    // Deadlock detection fires at deadlock_timeout (1s) + retry backoff —
    // leave generous headroom for a loaded machine.
    { timeout: 15_000 },
  );
});
