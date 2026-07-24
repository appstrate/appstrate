// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the transactional storage-deletion outbox (tier0, FS
 * storage):
 *
 *  - `deleteDocument` deletes the row AND enqueues a pending deletion job in the
 *    SAME transaction; a failing worker delete leaves the job pending; a later
 *    pass completes it.
 *  - worker pass: success → completedAt; failure → attempts+1, backoff, lastError.
 *  - dead letter: a job past the threshold appears in the dead list; retry resets it.
 *  - `deleteOrganization` enqueues documents + uploads keys before the FK cascade.
 *  - `deleteEndUser` enqueues the end-user's staged upload key before the cascade.
 *  - `cleanupExpiredDocuments` enqueues instead of best-effort deleting.
 *  - concurrent worker passes don't double-claim (SKIP LOCKED).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  applications,
  documents,
  uploads,
  runs,
  organizations,
  storageDeletionJobs,
} from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  createDocumentFromStream,
  deleteDocument,
  cleanupExpiredDocuments,
} from "../../../src/services/documents.ts";
import { deleteOrganization } from "../../../src/services/organizations.ts";
import { createEndUser, deleteEndUser } from "../../../src/services/end-users.ts";
import { createApplication, deleteApplication } from "../../../src/services/applications.ts";
import { createUpload } from "../../../src/services/uploads.ts";
import {
  enqueueStorageDeletion,
  processStorageDeletionJobs,
  listStorageDeletionJobs,
  retryStorageDeletionJob,
  STORAGE_DELETION_DEAD_LETTER_THRESHOLD,
} from "../../../src/services/storage-deletion.ts";

const app = getTestApp();

type Scope = { orgId: string; applicationId: string };

/** Seed a minimal run row (terminal by default so org delete isn't blocked). */
async function seedRunRow(
  scope: Scope,
  status: "running" | "success" = "success",
  endUserId: string | null = null,
): Promise<string> {
  const id = `run_${crypto.randomUUID()}`;
  await db.insert(runs).values({
    id,
    orgId: scope.orgId,
    applicationId: scope.applicationId,
    endUserId,
    status,
    startedAt: new Date(),
  });
  return id;
}

/** Publish an `agent_output` document from a run's streaming channel; returns the row. */
async function publishDoc(
  scope: Scope,
  runId: string,
  name: string,
  content: string,
  actor: { userId: string | null; endUserId: string | null } = {
    userId: null,
    endUserId: null,
  },
) {
  const { row } = await createDocumentFromStream(scope, runId, actor, null, {
    name,
    mime: "text/plain",
    body: new Blob([new TextEncoder().encode(content)]).stream(),
  });
  return row;
}

/** Split a stored `bucket/path` key into `{ bucket, inKey }`. */
function split(storageKey: string): { bucket: string; inKey: string } {
  const [bucket, ...rest] = storageKey.split("/");
  return { bucket: bucket!, inKey: rest.join("/") };
}

describe("storage-deletion outbox", () => {
  let ctx: TestContext;
  let scope: Scope;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "sdjorg" });
    scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    void app;
  });

  it("deleteDocument removes the row and enqueues a pending job in the same tx; worker completes it", async () => {
    const runId = await seedRunRow(scope);
    const doc = await publishDoc(scope, runId, "d.txt", "some bytes");
    const { bucket, inKey } = split(doc.storageKey);

    await deleteDocument(scope, doc.id);

    // Row gone.
    expect(await db.select().from(documents).where(eq(documents.id, doc.id))).toHaveLength(0);

    // Exactly one pending job for the object.
    const jobs = await db
      .select()
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.storageKey, inKey));
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.bucket).toBe(bucket);
    expect(job.reason).toBe("document_deleted");
    expect(job.completedAt).toBeNull();
    expect(job.attempts).toBe(0);

    // A failing worker delete leaves the job pending with attempts+1 + backoff.
    let failCalls = 0;
    const failed = await processStorageDeletionJobs({
      deleteFile: async () => {
        failCalls += 1;
        throw new Error("storage boom");
      },
      rand: () => 0,
    });
    expect(failCalls).toBe(1);
    expect(failed.failed).toBe(1);
    const [afterFail] = await db
      .select()
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.id, job.id));
    expect(afterFail!.completedAt).toBeNull();
    expect(afterFail!.attempts).toBe(1);
    expect(afterFail!.lastError).toContain("storage boom");
    expect(afterFail!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // Reset the backoff (operator retry), then a succeeding pass completes it.
    await retryStorageDeletionJob(job.id);
    const okKeys: string[] = [];
    const ok = await processStorageDeletionJobs({
      deleteFile: async (b, k) => void okKeys.push(`${b}/${k}`),
    });
    expect(ok.completed).toBe(1);
    expect(okKeys).toEqual([`${bucket}/${inKey}`]);
    const [done] = await db
      .select()
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.id, job.id));
    expect(done!.completedAt).not.toBeNull();
    expect(done!.lastError).toBeNull();
  });

  it("worker: mixed batch — success completes, failure increments attempts + backoff + lastError", async () => {
    await db.transaction((tx) =>
      enqueueStorageDeletion(tx, [
        { bucket: "documents", storageKey: "ok/a.txt", reason: "document_deleted" },
        { bucket: "documents", storageKey: "fail/b.txt", reason: "document_deleted" },
      ]),
    );

    const res = await processStorageDeletionJobs({
      deleteFile: async (_b, key) => {
        if (key === "fail/b.txt") throw new Error("nope");
      },
      rand: () => 0,
    });
    expect(res.claimed).toBe(2);
    expect(res.completed).toBe(1);
    expect(res.failed).toBe(1);

    const [ok] = await db
      .select()
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.storageKey, "ok/a.txt"));
    expect(ok!.completedAt).not.toBeNull();
    expect(ok!.attempts).toBe(0);

    const [bad] = await db
      .select()
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.storageKey, "fail/b.txt"));
    expect(bad!.completedAt).toBeNull();
    expect(bad!.attempts).toBe(1);
    expect(bad!.lastError).toContain("nope");
    // First failure backs off ≈30s (base) — comfortably in the future.
    expect(bad!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
  });

  it("dead letter: a job past the threshold shows in the dead list; retry resets nextAttemptAt", async () => {
    await db.transaction((tx) =>
      enqueueStorageDeletion(tx, {
        bucket: "documents",
        storageKey: "dead/x",
        reason: "document_deleted",
      }),
    );
    const [j] = await db
      .select()
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.storageKey, "dead/x"));
    // Force it past the dead-letter threshold, parked far in the future.
    await db
      .update(storageDeletionJobs)
      .set({
        attempts: STORAGE_DELETION_DEAD_LETTER_THRESHOLD,
        nextAttemptAt: new Date(Date.now() + 9_999_999),
      })
      .where(eq(storageDeletionJobs.id, j!.id));

    const dead = await listStorageDeletionJobs({ status: "dead", limit: 50 });
    expect(dead.items.some((i) => i.id === j!.id)).toBe(true);
    // Dead is a subset of pending.
    const pending = await listStorageDeletionJobs({ status: "pending", limit: 50 });
    expect(pending.items.some((i) => i.id === j!.id)).toBe(true);
    // Not completed → absent from the completed list.
    const completed = await listStorageDeletionJobs({ status: "completed", limit: 50 });
    expect(completed.items.some((i) => i.id === j!.id)).toBe(false);

    // Retry resets nextAttemptAt to ~now (keeps it retrying — never abandoned).
    expect(await retryStorageDeletionJob(j!.id)).toBe(true);
    const [after] = await db
      .select()
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.id, j!.id));
    expect(after!.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 2000);
    expect(after!.completedAt).toBeNull();

    // Retrying a completed / unknown job is a no-op.
    expect(await retryStorageDeletionJob("sdj_does-not-exist")).toBe(false);
  });

  it("paginates every job when several rows share the same createdAt", async () => {
    const createdAt = new Date("2026-07-24T10:00:00.000Z");
    await db.insert(storageDeletionJobs).values(
      ["a", "b", "c"].map((suffix) => ({
        id: `sdj_cursor_${suffix}`,
        bucket: "documents",
        storageKey: `cursor/${suffix}`,
        reason: "document_deleted",
        createdAt,
      })),
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listStorageDeletionJobs({
        status: "pending",
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toEqual(["sdj_cursor_c", "sdj_cursor_b", "sdj_cursor_a"]);
    expect(new Set(seen).size).toBe(3);
  });

  it("expands a run manifest and deletes it last so a failed pass stays retryable", async () => {
    const runId = `run_${crypto.randomUUID()}`;
    const manifestKey = `${runId}/manifest.json`;
    const manifest = new TextEncoder().encode(
      JSON.stringify({
        documents: [
          { name: "A", workspace_name: "a.txt", size: 1 },
          { name: "B", workspace_name: "b.txt", size: 1 },
        ],
      }),
    );
    await db.transaction((tx) =>
      enqueueStorageDeletion(tx, {
        bucket: "run-workspace",
        storageKey: manifestKey,
        reason: "org_deleted",
      }),
    );

    const deleted: string[] = [];
    let failB = true;
    const deleteFile = async (_bucket: string, key: string): Promise<void> => {
      deleted.push(key);
      if (failB && key.endsWith("/b.txt")) throw new Error("temporary storage failure");
    };
    const downloadFile = async (): Promise<Uint8Array> => manifest;

    const failed = await processStorageDeletionJobs({ deleteFile, downloadFile, rand: () => 0 });
    expect(failed.failed).toBe(1);
    expect(deleted).toEqual([`${runId}/documents/a.txt`, `${runId}/documents/b.txt`]);
    expect(deleted).not.toContain(manifestKey);

    failB = false;
    const [job] = await db
      .select({ id: storageDeletionJobs.id })
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.storageKey, manifestKey));
    await retryStorageDeletionJob(job!.id);
    const retried = await processStorageDeletionJobs({ deleteFile, downloadFile });
    expect(retried.completed).toBe(1);
    expect(deleted.slice(-3)).toEqual([
      `${runId}/documents/a.txt`,
      `${runId}/documents/b.txt`,
      manifestKey,
    ]);
  });

  it("deleteOrganization enqueues documents + uploads keys before the FK cascade", async () => {
    const runId = await seedRunRow(scope, "success");
    const doc = await publishDoc(scope, runId, "org-doc.txt", "org bytes");
    const { bucket: docBucket, inKey: docKey } = split(doc.storageKey);

    const up = await createUpload({
      orgId: scope.orgId,
      applicationId: scope.applicationId,
      createdBy: ctx.user.id,
      name: "u.txt",
      size: 4,
      mime: "text/plain",
    });
    const [upRow] = await db
      .select({ storageKey: uploads.storageKey })
      .from(uploads)
      .where(eq(uploads.id, up.id));
    const { bucket: upBucket, inKey: upKey } = split(upRow!.storageKey);

    await deleteOrganization(scope.orgId);

    // Org (and its cascade) gone.
    expect(
      await db.select().from(organizations).where(eq(organizations.id, scope.orgId)),
    ).toHaveLength(0);

    // A deletion job exists for the document object and the upload object.
    const docJob = await db
      .select()
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.storageKey, docKey));
    expect(docJob).toHaveLength(1);
    expect(docJob[0]!.bucket).toBe(docBucket);
    expect(docJob[0]!.reason).toBe("org_deleted");

    const upJob = await db
      .select()
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.storageKey, upKey));
    expect(upJob).toHaveLength(1);
    expect(upJob[0]!.bucket).toBe(upBucket);
    expect(upJob[0]!.reason).toBe("org_deleted");

    // Run-workspace bundle + manifest keys enqueued per run.
    const runJobs = await db
      .select()
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.bucket, "run-workspace"));
    const runKeys = new Set(runJobs.map((r) => r.storageKey));
    expect(runKeys.has(`${runId}.afps`)).toBe(true);
    expect(runKeys.has(`${runId}/manifest.json`)).toBe(true);
  });

  it("deleteApplication keeps the org quota exact and queues all cascade-owned storage", async () => {
    const appRow = await createApplication(scope.orgId, { name: "Disposable" }, ctx.user.id);
    const appScope = { orgId: scope.orgId, applicationId: appRow.id };
    const runId = await seedRunRow(appScope);
    const doc = await publishDoc(appScope, runId, "app-doc.txt", "application bytes");
    const { inKey: docKey } = split(doc.storageKey);
    const [before] = await db
      .select({ used: organizations.documentsBytesUsed })
      .from(organizations)
      .where(eq(organizations.id, scope.orgId));
    expect(before!.used).toBe(doc.size);

    await deleteApplication(scope.orgId, appRow.id);

    expect(await db.select().from(applications).where(eq(applications.id, appRow.id))).toHaveLength(
      0,
    );
    const [after] = await db
      .select({ used: organizations.documentsBytesUsed })
      .from(organizations)
      .where(eq(organizations.id, scope.orgId));
    expect(after!.used).toBe(0);
    expect(
      await db.select().from(storageDeletionJobs).where(eq(storageDeletionJobs.storageKey, docKey)),
    ).toHaveLength(1);

    const workspaceJobs = await db
      .select({ storageKey: storageDeletionJobs.storageKey })
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.bucket, "run-workspace"));
    expect(new Set(workspaceJobs.map((job) => job.storageKey))).toEqual(
      new Set([`${runId}.afps`, `${runId}/manifest.json`]),
    );
  });

  it("deleteEndUser purges owned bytes but preserves its surviving run workspace", async () => {
    const endUser = await createEndUser(scope, { name: "eu-with-upload" });
    const runId = await seedRunRow(scope, "success", endUser.id);
    const doc = await publishDoc(scope, runId, "eu-doc.txt", "end-user bytes", {
      userId: null,
      endUserId: endUser.id,
    });

    // A staged upload attributed to the end-user (endUserId, no dashboard user).
    const up = await createUpload({
      orgId: scope.orgId,
      applicationId: scope.applicationId,
      createdBy: null,
      endUserId: endUser.id,
      name: "eu.txt",
      size: 4,
      mime: "text/plain",
    });
    const [upRow] = await db
      .select({ storageKey: uploads.storageKey })
      .from(uploads)
      .where(eq(uploads.id, up.id));
    const { bucket: upBucket, inKey: upKey } = split(upRow!.storageKey);

    await deleteEndUser(scope, endUser.id);

    const [survivingRun] = await db
      .select({ endUserId: runs.endUserId })
      .from(runs)
      .where(eq(runs.id, runId));
    expect(survivingRun).toEqual({ endUserId: null });
    const [org] = await db
      .select({ used: organizations.documentsBytesUsed })
      .from(organizations)
      .where(eq(organizations.id, scope.orgId));
    expect(org!.used).toBe(0);

    const upJob = await db
      .select()
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.storageKey, upKey));
    expect(upJob).toHaveLength(1);
    expect(upJob[0]!.bucket).toBe(upBucket);
    expect(upJob[0]!.reason).toBe("end_user_deleted");
    expect(upJob[0]!.completedAt).toBeNull();
    const { inKey: docKey } = split(doc.storageKey);
    expect(
      await db.select().from(storageDeletionJobs).where(eq(storageDeletionJobs.storageKey, docKey)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(storageDeletionJobs)
        .where(eq(storageDeletionJobs.bucket, "run-workspace")),
    ).toHaveLength(0);
  });

  it("cleanupExpiredDocuments enqueues the purge instead of best-effort deleting", async () => {
    const runId = await seedRunRow(scope);
    const doc = await publishDoc(scope, runId, "old.txt", "expired bytes");
    const { inKey } = split(doc.storageKey);
    // Make it eligible for the expiry sweep.
    await db
      .update(documents)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(documents.id, doc.id));

    const removed = await cleanupExpiredDocuments();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(documents).where(eq(documents.id, doc.id))).toHaveLength(0);

    const jobs = await db
      .select()
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.storageKey, inKey));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.reason).toBe("document_expired");
    expect(jobs[0]!.completedAt).toBeNull();
  });

  it("a second pass does not re-claim already-completed jobs", async () => {
    await db.transaction((tx) =>
      enqueueStorageDeletion(tx, [
        { bucket: "documents", storageKey: "seq/1", reason: "document_deleted" },
        { bucket: "documents", storageKey: "seq/2", reason: "document_deleted" },
      ]),
    );
    const seen: string[] = [];
    const del = async (_b: string, key: string): Promise<void> => void seen.push(key);

    const first = await processStorageDeletionJobs({ deleteFile: del });
    expect(first.completed).toBe(2);
    const second = await processStorageDeletionJobs({ deleteFile: del });
    // Nothing left to claim — the completed_at IS NULL filter excludes them.
    expect(second.claimed).toBe(0);
    expect(seen.sort()).toEqual(["seq/1", "seq/2"]);
  });

  // The claim is a single UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP
  // LOCKED) that leases the rows (pushes next_attempt_at forward), so two passes
  // can never both claim the same job: real Postgres partitions them via SKIP
  // LOCKED; PGlite serializes the two claims on its single connection and the
  // lease keeps the second from re-picking the first's rows. Safe on both tiers.
  it("concurrent worker passes don't double-claim (SKIP LOCKED lease)", async () => {
    const keys = Array.from({ length: 8 }, (_, i) => `conc/${i}`);
    await db.transaction((tx) =>
      enqueueStorageDeletion(
        tx,
        keys.map((k) => ({ bucket: "documents", storageKey: k, reason: "document_deleted" })),
      ),
    );
    const seen: string[] = [];
    const del = async (_b: string, key: string): Promise<void> => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(key);
    };
    const [a, b] = await Promise.all([
      processStorageDeletionJobs({ deleteFile: del }),
      processStorageDeletionJobs({ deleteFile: del }),
    ]);
    expect(a.completed + b.completed).toBe(8);
    // Every key deleted exactly once — no overlap between the two passes.
    expect(seen.length).toBe(8);
    expect(new Set(seen).size).toBe(8);
  });
});
