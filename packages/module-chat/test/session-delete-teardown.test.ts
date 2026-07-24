// SPDX-License-Identifier: Apache-2.0

/**
 * Session-delete document teardown — the storage-accounting contract of
 * `DELETE /api/chat/sessions/:id`.
 *
 * The route runs the document teardown (`cleanupSessionDocuments`, wired to the
 * platform's `detachOrDeleteContainedDocuments`) and the `chat_sessions` row
 * delete in ONE transaction, so they commit atomically. This closes an orphan
 * window: an attachment materializing between the two — as two separate
 * statements — would be cascade-deleted by the FK with no storage-deletion
 * outbox job, stranding its S3 object forever (the byte counter self-heals via
 * the daily reconcile; the blob does not).
 *
 * These tests drive the same primitive the route calls, wrapped in the same
 * atomic block, against the real platform (storage + DB): an unconsumed session
 * document is deleted AND its object is enqueued into `storage_deletion_jobs` in
 * the same commit, and a failure of the session-row delete rolls the whole
 * teardown back.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  chatSessions,
  documents,
  organizations,
  storageDeletionJobs,
  uploads,
} from "@appstrate/db/schema";
import { uploadStream } from "@appstrate/db/storage";
import type { Actor } from "@appstrate/connect";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../../apps/api/test/helpers/auth.ts";
import { createUpload } from "../../../apps/api/src/services/uploads.ts";
import {
  createDocumentFromUpload,
  detachOrDeleteContainedDocuments,
} from "../../../apps/api/src/services/documents.ts";

// Boot the platform app once (registers routes, storage, DB) — the tests drive
// the services directly, so the handle itself is not referenced.
getTestApp();

/** Stage an upload row + write its bytes into the uploads bucket (FS). */
async function stageUpload(
  scope: { orgId: string; applicationId: string },
  createdBy: string,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  const up = await createUpload({
    orgId: scope.orgId,
    applicationId: scope.applicationId,
    createdBy,
    name,
    size: bytes.byteLength,
    mime: "text/plain",
  });
  const [row] = await db
    .select({ storageKey: uploads.storageKey })
    .from(uploads)
    .where(eq(uploads.id, up.id));
  const [bucket, ...rest] = row!.storageKey.split("/");
  await uploadStream(bucket!, rest.join("/"), new Blob([bytes]).stream(), { exclusive: true });
  return up.id;
}

/** A chat session row owned by `userId`. */
async function createSession(orgId: string, userId: string): Promise<string> {
  const id = `chs_${crypto.randomUUID()}`;
  await db.insert(chatSessions).values({ id, orgId, userId, title: null });
  return id;
}

async function orgBytesUsed(orgId: string): Promise<number> {
  const [org] = await db
    .select({ used: organizations.documentsBytesUsed })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return org!.used;
}

describe("chat session delete — document teardown", () => {
  let ctx: TestContext;
  let scope: { orgId: string; applicationId: string };
  let actor: Actor;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatteardown" });
    scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    actor = { type: "user", id: ctx.user.id };
  });

  it("removes the session's documents and enqueues their storage-deletion jobs atomically", async () => {
    const sessionId = await createSession(ctx.orgId, ctx.user.id);
    const bytes = new TextEncoder().encode("session attachment payload");
    const uploadId = await stageUpload(scope, ctx.user.id, "att.txt", bytes);
    const doc = await createDocumentFromUpload(scope, actor, uploadId, {
      chatSessionId: sessionId,
    });

    expect(await orgBytesUsed(ctx.orgId)).toBe(bytes.byteLength);
    const [, ...pathParts] = doc.storageKey.split("/");
    const inBucketKey = pathParts.join("/");

    // Mirror the DELETE /api/chat/sessions/:id route: teardown + session-row
    // delete in ONE transaction (the tx threaded into the teardown).
    await db.transaction(async (tx) => {
      await detachOrDeleteContainedDocuments({ chatSessionId: sessionId }, tx);
      await tx.delete(chatSessions).where(eq(chatSessions.id, sessionId));
    });

    // The document row is gone and its bytes folded back off the org counter.
    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row).toBeUndefined();
    expect(await orgBytesUsed(ctx.orgId)).toBe(0);
    // The session row is gone.
    const [sess] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
    expect(sess).toBeUndefined();
    // The object was enqueued into the transactional deletion outbox in the SAME
    // commit — so the FK cascade never orphaned it.
    const jobs = await db
      .select()
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.storageKey, inBucketKey));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.reason).toBe("document_deleted");
  });

  it("rolls the teardown back when the session-row delete fails (atomic)", async () => {
    const sessionId = await createSession(ctx.orgId, ctx.user.id);
    const bytes = new TextEncoder().encode("must survive a rollback");
    const uploadId = await stageUpload(scope, ctx.user.id, "att.txt", bytes);
    const doc = await createDocumentFromUpload(scope, actor, uploadId, {
      chatSessionId: sessionId,
    });

    // A transaction that tears the documents down, then throws before/at the
    // session-row delete, must leave NOTHING committed: the document teardown
    // and the outbox enqueue share the same rolled-back transaction.
    await expect(
      db.transaction(async (tx) => {
        await detachOrDeleteContainedDocuments({ chatSessionId: sessionId }, tx);
        throw new Error("session-row delete failed");
      }),
    ).rejects.toThrow("session-row delete failed");

    // Document row still present, counter intact, no outbox job leaked.
    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row).toBeDefined();
    expect(row!.chatSessionId).toBe(sessionId);
    expect(await orgBytesUsed(ctx.orgId)).toBe(bytes.byteLength);
    const [, ...pathParts] = doc.storageKey.split("/");
    const jobs = await db
      .select()
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.storageKey, pathParts.join("/")));
    expect(jobs).toHaveLength(0);
  });
});
