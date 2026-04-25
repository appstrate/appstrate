// SPDX-License-Identifier: Apache-2.0

/**
 * Migration data-preservation test (ADR-011 Phase 1).
 *
 * The 0010_package_persistence migration back-fills:
 *   - every `package_memories` row → `kind='memory', actor_type='shared'`
 *   - the latest `runs.state` per `(package, app, actor)` →
 *     `kind='checkpoint'` with the right actor_type/actor_id derived
 *     from `dashboard_user_id` / `end_user_id`
 *
 * The migration itself is applied at preload time. To verify it does the
 * right thing we re-run the back-fill clauses (idempotent — `ON CONFLICT
 * DO NOTHING`) against freshly-seeded source data. This is the only
 * faithful way to exercise the migration logic without rebuilding the
 * schema, and it doubles as a regression guard against the PGlite-compat
 * rewrites (CTE + COALESCE) deviating from `DISTINCT ON` semantics.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packageMemories, packagePersistence } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedEndUser } from "../../helpers/seed.ts";

// ---------------------------------------------------------------------------
// Back-fill SQL — copies from 0010_package_persistence.sql verbatim (sans
// the CREATE TABLE/INDEX clauses, which are already in place).
// ---------------------------------------------------------------------------

async function runBackfill(): Promise<void> {
  // Memories → shared rows.
  await db.execute(sql`
    INSERT INTO "package_persistence"
      (package_id, application_id, org_id, kind, actor_type, actor_id, content, run_id, created_at, updated_at)
    SELECT
      pm.package_id,
      pm.application_id,
      pm.org_id,
      'memory',
      'shared',
      NULL,
      to_jsonb(pm.content),
      pm.run_id,
      pm.created_at,
      pm.created_at
    FROM "package_memories" pm
    ON CONFLICT DO NOTHING
  `);

  // Latest runs.state per (package, app, actor) → checkpoint rows.
  await db.execute(sql`
    WITH ranked AS (
      SELECT
        r.package_id,
        r.application_id,
        r.org_id,
        r.dashboard_user_id,
        r.end_user_id,
        r.state,
        r.id AS run_id,
        r.started_at,
        ROW_NUMBER() OVER (
          PARTITION BY r.package_id, r.application_id, r.dashboard_user_id, r.end_user_id
          ORDER BY r.started_at DESC
        ) AS rn
      FROM "runs" r
      WHERE r.state IS NOT NULL
    )
    INSERT INTO "package_persistence"
      (package_id, application_id, org_id, kind, actor_type, actor_id, content, run_id, created_at, updated_at)
    SELECT
      ranked.package_id,
      ranked.application_id,
      ranked.org_id,
      'checkpoint',
      CASE
        WHEN ranked.end_user_id IS NOT NULL       THEN 'end_user'
        WHEN ranked.dashboard_user_id IS NOT NULL THEN 'user'
        ELSE 'shared'
      END,
      COALESCE(ranked.end_user_id, ranked.dashboard_user_id),
      ranked.state,
      ranked.run_id,
      ranked.started_at,
      ranked.started_at
    FROM ranked
    WHERE ranked.rn = 1
    ON CONFLICT DO NOTHING
  `);
}

// ---------------------------------------------------------------------------

describe("0009 migration back-fill — data preservation", () => {
  let ctx: TestContext;
  const packageId = "@migrateorg/agent";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "migrateorg" });
    await seedAgent({ id: packageId, orgId: ctx.orgId, createdBy: ctx.user.id });
  });

  it("migrates every package_memories row to a shared persistence row", async () => {
    await db.insert(packageMemories).values([
      {
        packageId,
        applicationId: ctx.defaultAppId,
        orgId: ctx.orgId,
        content: "first",
        runId: null,
      },
      {
        packageId,
        applicationId: ctx.defaultAppId,
        orgId: ctx.orgId,
        content: "second",
        runId: null,
      },
    ]);

    await runBackfill();

    const migrated = await db
      .select()
      .from(packagePersistence)
      .where(
        and(eq(packagePersistence.packageId, packageId), eq(packagePersistence.kind, "memory")),
      );
    expect(migrated).toHaveLength(2);
    for (const row of migrated) {
      expect(row.actorType).toBe("shared");
      expect(row.actorId).toBeNull();
    }
    const contents = migrated.map((r) => r.content).sort();
    expect(contents).toEqual(["first", "second"]);
  });

  it("migrates only the LATEST runs.state per (package, app, actor) — DISTINCT ON equivalent", async () => {
    // Two runs for the dashboard user — only the freshest must back-fill.
    const t0 = new Date("2026-04-01T00:00:00Z");
    const t1 = new Date("2026-04-02T00:00:00Z");

    await seedRun({
      packageId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      dashboardUserId: ctx.user.id,
      status: "success",
      state: { v: "old" },
      startedAt: t0,
    });
    await seedRun({
      packageId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      dashboardUserId: ctx.user.id,
      status: "success",
      state: { v: "new" },
      startedAt: t1,
    });

    await runBackfill();

    const checkpoints = await db
      .select()
      .from(packagePersistence)
      .where(
        and(
          eq(packagePersistence.packageId, packageId),
          eq(packagePersistence.kind, "checkpoint"),
          eq(packagePersistence.actorType, "user"),
        ),
      );
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.actorId).toBe(ctx.user.id);
    expect(checkpoints[0]!.content).toEqual({ v: "new" });
  });

  it("preserves per-actor isolation: distinct (user / end_user / shared) coexist", async () => {
    const eu = await seedEndUser({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      externalId: `ext_${Date.now()}`,
    });

    // Three runs, three distinct actors, each with a checkpoint.
    await seedRun({
      packageId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      dashboardUserId: ctx.user.id,
      endUserId: null,
      status: "success",
      state: { actor: "user" },
    });
    await seedRun({
      packageId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      dashboardUserId: null,
      endUserId: eu.id,
      status: "success",
      state: { actor: "end_user" },
    });
    await seedRun({
      packageId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      dashboardUserId: null,
      endUserId: null,
      status: "success",
      state: { actor: "shared" },
    });

    await runBackfill();

    const all = await db
      .select()
      .from(packagePersistence)
      .where(
        and(eq(packagePersistence.packageId, packageId), eq(packagePersistence.kind, "checkpoint")),
      );

    const byActor = new Map(all.map((r) => [r.actorType, r]));
    expect(byActor.get("user")?.actorId).toBe(ctx.user.id);
    expect((byActor.get("user")?.content as Record<string, unknown>).actor).toBe("user");
    expect(byActor.get("end_user")?.actorId).toBe(eu.id);
    expect((byActor.get("end_user")?.content as Record<string, unknown>).actor).toBe("end_user");
    expect(byActor.get("shared")?.actorId).toBeNull();
    expect((byActor.get("shared")?.content as Record<string, unknown>).actor).toBe("shared");
  });

  it("checkpoint back-fill is idempotent on re-run (partial unique index dedupes)", async () => {
    await seedRun({
      packageId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      dashboardUserId: ctx.user.id,
      status: "success",
      state: { idempotent: true },
    });

    // First back-fill creates one checkpoint row.
    await runBackfill();
    // Second back-fill must hit the partial unique index
    // `pkp_checkpoint_unique` and the `ON CONFLICT DO NOTHING` clause —
    // no duplicate row is inserted. (Memories have no unique key in the
    // migration, so they would duplicate on re-run; the migration only
    // ever runs once in production, so we don't guard memory rows.)
    await runBackfill();

    const checkpoints = await db
      .select()
      .from(packagePersistence)
      .where(
        and(eq(packagePersistence.packageId, packageId), eq(packagePersistence.kind, "checkpoint")),
      );
    expect(checkpoints).toHaveLength(1);
  });
});
