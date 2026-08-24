// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0044_finish_file_rename` — the data half of finishing the #1177
 * rename at the physical layer.
 *
 * The migration chain is replayed at boot by the tier-0 harness, so a
 * SYNTACTICALLY broken migration already fails every integration test. What
 * that does NOT prove is that the migration does anything: it runs against an
 * empty database, where a WHERE clause that never matches and one that matches
 * everything are indistinguishable.
 *
 * So this test seeds the rows the migration exists for and replays the exact
 * SQL file, twice — once to assert the rewrite, once to assert the rewrite is
 * idempotent (a partially-applied environment must converge, and re-running a
 * data migration must never be destructive).
 *
 * The two `DROP COLUMN IF EXISTS` statements in the same file are covered by
 * the replay too: the columns are already gone by the time this runs, so the
 * guard is what keeps the second (and here, every) pass from erroring.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { sql, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { files, storageDeletionJobs } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";

const MIGRATION = new URL(
  "../../../../../packages/db/drizzle/0044_finish_file_rename.sql",
  import.meta.url,
).pathname;

async function replayMigration(): Promise<void> {
  const source = await Bun.file(MIGRATION).text();
  for (const statement of source.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (!trimmed) continue;
    await db.execute(sql.raw(trimmed));
  }
}

async function seedFile(ctx: TestContext, storageKey: string): Promise<string> {
  const id = `file_${crypto.randomUUID()}`;
  await db.insert(files).values({
    id,
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    purpose: "agent_output",
    storageKey,
    name: "report.html",
    mime: "text/html",
    size: 12,
    sha256: "deadbeef",
  });
  return id;
}

async function storageKeyOf(id: string): Promise<string> {
  const [row] = await db
    .select({ storageKey: files.storageKey })
    .from(files)
    .where(eq(files.id, id));
  return row!.storageKey;
}

async function seedJob(bucket: string, storageKey: string, reason: string): Promise<string> {
  const id = `sdj_${crypto.randomUUID()}`;
  await db.insert(storageDeletionJobs).values({ id, bucket, storageKey, reason });
  return id;
}

async function jobOf(id: string): Promise<{ bucket: string; storageKey: string; reason: string }> {
  const [row] = await db
    .select({
      bucket: storageDeletionJobs.bucket,
      storageKey: storageDeletionJobs.storageKey,
      reason: storageDeletionJobs.reason,
    })
    .from(storageDeletionJobs)
    .where(eq(storageDeletionJobs.id, id));
  return row!;
}

describe("migration 0044 — finish the file rename at the physical layer", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "finish-file-rename" });
  });

  it("rewrites the `documents/` storage-key prefix and leaves the rest of the key alone", async () => {
    const legacy = await seedFile(ctx, "documents/app_1/file_abcd1234/report.html");
    // A path whose LATER segments contain the word must survive untouched —
    // the rewrite is anchored on the bucket segment, which is the only one it
    // is allowed to move.
    const nested = await seedFile(ctx, "documents/app_1/file_bbbb2222/documents/notes.md");

    await replayMigration();

    expect(await storageKeyOf(legacy)).toBe("files/app_1/file_abcd1234/report.html");
    expect(await storageKeyOf(nested)).toBe("files/app_1/file_bbbb2222/documents/notes.md");
  });

  it("leaves a key already on the new layout byte-identical", async () => {
    const already = await seedFile(ctx, "files/app_1/file_cccc3333/report.html");
    await replayMigration();
    expect(await storageKeyOf(already)).toBe("files/app_1/file_cccc3333/report.html");
  });

  it("rewrites the outbox's bucket, run-workspace key segment and reason labels", async () => {
    const durable = await seedJob("documents", "app_1/file_dddd4444/a.txt", "document_deleted");
    const expired = await seedJob("documents", "app_1/file_eeee5555/b.txt", "document_expired");
    const workspace = await seedJob(
      "run-workspace",
      "run_7/documents/brief.pdf",
      "run_input_rollback",
    );
    const bundle = await seedJob("run-workspace", "run_7.afps", "run_workspace_deleted");
    const other = await seedJob("uploads", "upl_ffff6666", "upload_expired");

    await replayMigration();

    expect(await jobOf(durable)).toEqual({
      bucket: "files",
      storageKey: "app_1/file_dddd4444/a.txt",
      reason: "file_deleted",
    });
    expect(await jobOf(expired)).toEqual({
      bucket: "files",
      storageKey: "app_1/file_eeee5555/b.txt",
      reason: "file_expired",
    });
    expect(await jobOf(workspace)).toEqual({
      bucket: "run-workspace",
      storageKey: "run_7/files/brief.pdf",
      reason: "run_input_rollback",
    });
    // Not every run-workspace key carries the segment; the bundle key has no
    // second segment at all and must come through unchanged.
    expect(await jobOf(bundle)).toEqual({
      bucket: "run-workspace",
      storageKey: "run_7.afps",
      reason: "run_workspace_deleted",
    });
    // A different bucket is out of the rewrite's reach entirely.
    expect(await jobOf(other)).toEqual({
      bucket: "uploads",
      storageKey: "upl_ffff6666",
      reason: "upload_expired",
    });
  });

  it("is idempotent — a second pass changes nothing", async () => {
    const file = await seedFile(ctx, "documents/app_1/file_9999aaaa/report.html");
    const job = await seedJob("documents", "app_1/file_9999aaaa/report.html", "document_deleted");
    const workspace = await seedJob(
      "run-workspace",
      "run_8/documents/brief.pdf",
      "run_input_rollback",
    );

    await replayMigration();
    const afterFirst = {
      file: await storageKeyOf(file),
      job: await jobOf(job),
      workspace: await jobOf(workspace),
    };

    await replayMigration();

    expect(await storageKeyOf(file)).toBe(afterFirst.file);
    expect(await jobOf(job)).toEqual(afterFirst.job);
    expect(await jobOf(workspace)).toEqual(afterFirst.workspace);
  });

  it("dropped both write-only columns — the catalog no longer carries them", async () => {
    // `db.execute` returns `{ rows }` on the PGlite driver and a bare array on
    // postgres.js, so the tier the suite runs at decides the shape.
    const result = await db.execute(sql`
      SELECT table_name || '.' || column_name AS ref
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'model_provider_credentials' AND column_name = 'last_refresh_failure_at')
          OR (table_name = 'model_provider_pairings' AND column_name = 'consumed_from_ip')
        )
    `);
    const rows = ((result as { rows?: unknown[] }).rows ?? result) as Array<{ ref: string }>;
    expect(rows.map((r) => r.ref)).toEqual([]);
  });
});
