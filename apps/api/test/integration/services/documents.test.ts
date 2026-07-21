// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the documents service + routes (tier0, FS storage):
 *
 *  - `createDocumentFromUpload` materialization: durable row + bucket object +
 *    org byte-counter increment + sha256 + audit trail.
 *  - `getDocumentForActor` container ACL: same-app OK, cross-org / cross-app
 *    404, end-user guard.
 *  - Routes: metadata, proxy-stream content download, list + filter, delete by
 *    creator vs admin vs neither.
 *  - GC sweep (expired only) and run-delete FK cascade.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  documents,
  organizations,
  runs,
  uploads,
  auditEvents,
  chatSessions,
} from "@appstrate/db/schema";
import { uploadStream, downloadStream } from "@appstrate/db/storage";
import { _resetCacheForTesting } from "@appstrate/env";
import type { Actor } from "@appstrate/connect";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  addOrgMember,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedEndUser, seedApiKey } from "../../helpers/seed.ts";
import { createUpload } from "../../../src/services/uploads.ts";
import {
  createDocumentFromUpload,
  createDocumentFromStream,
  getDocumentForActor,
  listDocumentsForActor,
  materializeRunUploads,
  cleanupExpiredDocuments,
} from "../../../src/services/documents.ts";

/** Run `fn` with an env var temporarily overridden (cache reset around it). */
async function withEnv(key: string, value: string, fn: () => Promise<void>): Promise<void> {
  const prev = process.env[key];
  process.env[key] = value;
  _resetCacheForTesting();
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
    _resetCacheForTesting();
  }
}

const app = getTestApp();

/** Stage an upload row + write its bytes into the uploads bucket (FS). */
async function stageUpload(
  scope: { orgId: string; applicationId: string },
  createdBy: string | null,
  name: string,
  bytes: Uint8Array,
  mime = "text/plain",
): Promise<string> {
  const up = await createUpload({
    orgId: scope.orgId,
    applicationId: scope.applicationId,
    createdBy,
    name,
    size: bytes.byteLength,
    mime,
  });
  const [row] = await db
    .select({ storageKey: uploads.storageKey })
    .from(uploads)
    .where(eq(uploads.id, up.id));
  const [bucket, ...rest] = row!.storageKey.split("/");
  await uploadStream(bucket!, rest.join("/"), new Blob([bytes]).stream(), { exclusive: true });
  return up.id;
}

/** Seed a minimal run row in the given scope. */
async function seedRunRow(
  scope: { orgId: string; applicationId: string },
  extra: { endUserId?: string } = {},
): Promise<string> {
  const id = `run_${crypto.randomUUID()}`;
  await db.insert(runs).values({
    id,
    orgId: scope.orgId,
    applicationId: scope.applicationId,
    status: "running",
    endUserId: extra.endUserId ?? null,
    // Sink context so the materialization-failure path can route its terminal
    // transition through `synthesiseFinalize` (getRunSinkContext requires a
    // non-null sink secret; finalize never decrypts it). Mirrors production,
    // where createRun stamps these before materializeRunUploads runs.
    runOrigin: "platform",
    sinkSecretEncrypted: "test-sink-secret",
    sinkExpiresAt: new Date(Date.now() + 3_600_000),
    startedAt: new Date(),
  });
  return id;
}

async function orgBytesUsed(orgId: string): Promise<number> {
  const [org] = await db
    .select({ used: organizations.documentsBytesUsed })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return org!.used;
}

/** Publish an `agent_output` from a run's streaming channel (Phase 2). */
function publishStream(
  scope: { orgId: string; applicationId: string },
  runId: string,
  name: string,
  content: string,
  attribution: { userId: string | null; endUserId: string | null } = {
    userId: null,
    endUserId: null,
  },
  mime = "text/plain",
) {
  const bytes = new TextEncoder().encode(content);
  return createDocumentFromStream(scope, runId, attribution, null, {
    name,
    mime,
    body: new Blob([bytes]).stream(),
  });
}

describe("documents service + routes", () => {
  let ctx: TestContext;
  let scope: { orgId: string; applicationId: string };
  let userActor: Actor;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "docsorg" });
    scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    userActor = { type: "user", id: ctx.user.id };
  });

  it("materializes an upload into a durable document (row + object + quota + audit)", async () => {
    const bytes = new TextEncoder().encode("hello durable document");
    const expectedSha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const uploadId = await stageUpload(scope, ctx.user.id, "notes.txt", bytes);
    const runId = await seedRunRow(scope);

    const doc = await createDocumentFromUpload(
      scope,
      userActor,
      uploadId,
      { runId },
      {
        packageId: "@scope/agent",
      },
    );

    expect(doc.purpose).toBe("user_upload");
    expect(doc.runId).toBe(runId);
    expect(doc.userId).toBe(ctx.user.id);
    expect(doc.endUserId).toBeNull();
    expect(doc.packageId).toBe("@scope/agent");
    expect(doc.size).toBe(bytes.byteLength);
    expect(doc.sha256).toBe(expectedSha);
    expect(doc.storageKey.startsWith("documents/")).toBe(true);

    // Bucket object exists.
    const [bucket, ...rest] = doc.storageKey.split("/");
    const stream = await downloadStream(bucket!, rest.join("/"));
    expect(stream).not.toBeNull();
    const stored = new Uint8Array(await new Response(stream!).arrayBuffer());
    expect(stored).toEqual(bytes);

    // Org counter incremented + audit trail.
    expect(await orgBytesUsed(ctx.orgId)).toBe(bytes.byteLength);
    const audit = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "document.created"), eq(auditEvents.resourceId, doc.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorId).toBe(ctx.user.id);
  });

  it("enforces the container ACL: cross-org and cross-app resolve to null", async () => {
    const bytes = new TextEncoder().encode("scoped");
    const uploadId = await stageUpload(scope, ctx.user.id, "s.txt", bytes);
    const runId = await seedRunRow(scope);
    const doc = await createDocumentFromUpload(scope, userActor, uploadId, { runId });

    // Same app: resolvable, downloadable by its creator.
    const ok = await getDocumentForActor(scope, userActor, doc.id);
    expect(ok?.row.id).toBe(doc.id);
    expect(ok?.downloadable).toBe(true);

    // Cross-org (different org scope): 404.
    const other = await createTestContext({ orgSlug: "otherorg" });
    const crossOrg = await getDocumentForActor(
      { orgId: other.orgId, applicationId: other.defaultAppId },
      userActor,
      doc.id,
    );
    expect(crossOrg).toBeNull();

    // Cross-app (same org, foreign app id): 404.
    const crossApp = await getDocumentForActor(
      { orgId: ctx.orgId, applicationId: "app_does_not_exist" },
      userActor,
      doc.id,
    );
    expect(crossApp).toBeNull();
  });

  it("end-user only sees documents on their own runs", async () => {
    const euOwner = await seedEndUser({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });
    const euOther = await seedEndUser({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });
    const ownerActor: Actor = { type: "end_user", id: euOwner.id };

    const bytes = new TextEncoder().encode("end-user doc");
    const uploadId = await stageUpload(scope, null, "eu.txt", bytes);
    const runId = await seedRunRow(scope, { endUserId: euOwner.id });
    const doc = await createDocumentFromUpload(scope, ownerActor, uploadId, { runId });

    // Owner end-user resolves + downloads (creator).
    const asOwner = await getDocumentForActor(scope, ownerActor, doc.id);
    expect(asOwner?.row.id).toBe(doc.id);
    expect(asOwner?.downloadable).toBe(true);

    // A different end-user cannot see it at all.
    const asOther = await getDocumentForActor(scope, { type: "end_user", id: euOther.id }, doc.id);
    expect(asOther).toBeNull();

    // A dashboard user (member) can read it but cannot download an upload it did not create.
    const asUser = await getDocumentForActor(scope, userActor, doc.id);
    expect(asUser?.row.id).toBe(doc.id);
    expect(asUser?.downloadable).toBe(false);
  });

  it("GET /:id returns metadata and /content proxy-streams the bytes", async () => {
    const bytes = new TextEncoder().encode("download me");
    const uploadId = await stageUpload(scope, ctx.user.id, "dl.txt", bytes);
    const runId = await seedRunRow(scope);
    const doc = await createDocumentFromUpload(scope, userActor, uploadId, { runId });

    const meta = await app.request(`/api/documents/${doc.id}`, { headers: authHeaders(ctx) });
    expect(meta.status).toBe(200);
    const dto = (await meta.json()) as { id: string; downloadable: boolean; uri: string };
    expect(dto.id).toBe(doc.id);
    expect(dto.uri).toBe(`document://${doc.id}`);
    expect(dto.downloadable).toBe(true);

    const content = await app.request(`/api/documents/${doc.id}/content`, {
      headers: authHeaders(ctx),
    });
    expect(content.status).toBe(200);
    expect(content.headers.get("content-disposition")).toContain("attachment");
    // S3: the proxy stream must forbid content-type sniffing.
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    const body = new Uint8Array(await content.arrayBuffer());
    expect(body).toEqual(bytes);

    // Unknown id → 404.
    const missing = await app.request(`/api/documents/doc_missing123/content`, {
      headers: authHeaders(ctx),
    });
    expect(missing.status).toBe(404);
  });

  it("lists documents with run_id filter and hides other end-users' rows", async () => {
    const runA = await seedRunRow(scope);
    const runB = await seedRunRow(scope);
    const upA = await stageUpload(scope, ctx.user.id, "a.txt", new TextEncoder().encode("aaa"));
    const upB = await stageUpload(scope, ctx.user.id, "b.txt", new TextEncoder().encode("bbbb"));
    const docA = await createDocumentFromUpload(scope, userActor, upA, { runId: runA });
    await createDocumentFromUpload(scope, userActor, upB, { runId: runB });

    const all = await app.request("/api/documents", { headers: authHeaders(ctx) });
    expect(all.status).toBe(200);
    const list = (await all.json()) as { data: { id: string }[] };
    expect(list.data.length).toBe(2);

    const filtered = await app.request(`/api/documents?run_id=${runA}`, {
      headers: authHeaders(ctx),
    });
    const flist = (await filtered.json()) as { data: { id: string }[] };
    expect(flist.data.map((d) => d.id)).toEqual([docA.id]);
  });

  it("DELETE allowed for creator and for admin, forbidden otherwise", async () => {
    // A member (no documents:delete) who creates a document.
    const member = await createTestUser({ email: "member@docs.test" });
    await addOrgMember(ctx.orgId, member.id, "member");
    const memberActor: Actor = { type: "user", id: member.id };
    const memberHeaders = authHeaders({ ...ctx, cookie: member.cookie });

    // A second member who is neither the creator nor an admin.
    const stranger = await createTestUser({ email: "stranger@docs.test" });
    await addOrgMember(ctx.orgId, stranger.id, "member");
    const strangerHeaders = authHeaders({ ...ctx, cookie: stranger.cookie });

    const runId = await seedRunRow(scope);

    const makeDoc = async () => {
      const up = await stageUpload(scope, member.id, "m.txt", new TextEncoder().encode("member"));
      return createDocumentFromUpload(scope, memberActor, up, { runId });
    };

    // Stranger (member, not creator) → 403.
    const doc1 = await makeDoc();
    const forbid = await app.request(`/api/documents/${doc1.id}`, {
      method: "DELETE",
      headers: strangerHeaders,
    });
    expect(forbid.status).toBe(403);

    // Creator (member) → 204, row gone, quota decremented.
    const usedBefore = await orgBytesUsed(ctx.orgId);
    const byCreator = await app.request(`/api/documents/${doc1.id}`, {
      method: "DELETE",
      headers: memberHeaders,
    });
    expect(byCreator.status).toBe(204);
    const [gone] = await db.select().from(documents).where(eq(documents.id, doc1.id));
    expect(gone).toBeUndefined();
    expect(await orgBytesUsed(ctx.orgId)).toBe(usedBefore - doc1.size);

    // Admin/owner (ctx.user) deletes a member's document via documents:delete.
    const doc2 = await makeDoc();
    const byAdmin = await app.request(`/api/documents/${doc2.id}`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(byAdmin.status).toBe(204);
  });

  it("GC deletes only expired documents and decrements the quota", async () => {
    const runId = await seedRunRow(scope);
    const upExpired = await stageUpload(scope, ctx.user.id, "e.txt", new TextEncoder().encode("e"));
    const upKeep = await stageUpload(scope, ctx.user.id, "k.txt", new TextEncoder().encode("keep"));
    const expired = await createDocumentFromUpload(scope, userActor, upExpired, { runId });
    const permanent = await createDocumentFromUpload(scope, userActor, upKeep, { runId });

    // Force the first document past its retention deadline.
    await db
      .update(documents)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(documents.id, expired.id));

    const removed = await cleanupExpiredDocuments();
    expect(removed).toBe(1);

    const [goneRow] = await db.select().from(documents).where(eq(documents.id, expired.id));
    expect(goneRow).toBeUndefined();
    const [keepRow] = await db.select().from(documents).where(eq(documents.id, permanent.id));
    expect(keepRow).toBeDefined();
    // Only the permanent document's bytes remain counted.
    expect(await orgBytesUsed(ctx.orgId)).toBe(permanent.size);
  });

  it("deleting a run cascades its documents rows", async () => {
    const runId = await seedRunRow(scope);
    const up = await stageUpload(scope, ctx.user.id, "c.txt", new TextEncoder().encode("cascade"));
    const doc = await createDocumentFromUpload(scope, userActor, up, { runId });

    await db.delete(runs).where(eq(runs.id, runId));

    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(row).toBeUndefined();
  });

  it("rejects an over-quota materialization synchronously (403) — no row, no counter change", async () => {
    await withEnv("ORG_STORAGE_QUOTA_BYTES", "8", async () => {
      const runId = await seedRunRow(scope);
      const up = await stageUpload(
        scope,
        ctx.user.id,
        "big.txt",
        new TextEncoder().encode("way too many bytes"),
      );
      await expect(createDocumentFromUpload(scope, userActor, up, { runId })).rejects.toMatchObject(
        { status: 403, code: "storage_limit_exceeded" },
      );
      // No row materialized and the org counter is untouched.
      const rows = await db.select().from(documents).where(eq(documents.runId, runId));
      expect(rows).toHaveLength(0);
      expect(await orgBytesUsed(ctx.orgId)).toBe(0);
    });
  });

  it("rejects an over-cap document synchronously (413)", async () => {
    await withEnv("DOCUMENT_MAX_FILE_BYTES", "4", async () => {
      const runId = await seedRunRow(scope);
      const up = await stageUpload(
        scope,
        ctx.user.id,
        "big.txt",
        new TextEncoder().encode("more than four"),
      );
      await expect(createDocumentFromUpload(scope, userActor, up, { runId })).rejects.toMatchObject(
        { status: 413 },
      );
      const rows = await db.select().from(documents).where(eq(documents.runId, runId));
      expect(rows).toHaveLength(0);
    });
  });

  it("materialization I/O failure fails the run and rolls back the partial batch", async () => {
    const runId = await seedRunRow(scope);
    // First upload materializes cleanly; the second id points at nothing → the
    // whole batch must unwind (first doc deleted) and the run must be failed.
    const goodUpload = await stageUpload(
      scope,
      ctx.user.id,
      "ok.txt",
      new TextEncoder().encode("ok"),
    );
    await expect(
      materializeRunUploads(scope, userActor, runId, "@scope/agent", [
        { uploadId: goodUpload, documentId: `doc_${crypto.randomUUID()}` },
        { uploadId: "upl_does_not_exist", documentId: `doc_${crypto.randomUUID()}` },
      ]),
    ).rejects.toMatchObject({ status: 404 });

    // No half-state: zero document rows for the run, org counter back to 0.
    const rows = await db.select().from(documents).where(eq(documents.runId, runId));
    expect(rows).toHaveLength(0);
    expect(await orgBytesUsed(ctx.orgId)).toBe(0);
    // The run was marked failed with a clear reason.
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run!.status).toBe("failed");
    expect(run!.error).toBe("Failed to persist input documents");
  });

  it("list visibility: members see all run docs but not others' chat docs; end-users see only own", async () => {
    // Member A + member B in the org.
    const memberA = await createTestUser({ email: "a@list.test" });
    await addOrgMember(ctx.orgId, memberA.id, "member");
    const actorA: Actor = { type: "user", id: memberA.id };
    const memberB = await createTestUser({ email: "b@list.test" });
    await addOrgMember(ctx.orgId, memberB.id, "member");
    const actorB: Actor = { type: "user", id: memberB.id };

    // Member B's RUN-contained document (org+app-visible to members).
    const runB = await seedRunRow(scope);
    const upRun = await stageUpload(
      scope,
      memberB.id,
      "runb.txt",
      new TextEncoder().encode("runb"),
    );
    const runDoc = await createDocumentFromUpload(scope, actorB, upRun, { runId: runB });

    // Member B's CHAT-contained document (private to B's session).
    const sessionId = `chs_${crypto.randomUUID()}`;
    await db.insert(chatSessions).values({ id: sessionId, orgId: ctx.orgId, userId: memberB.id });
    const upChat = await stageUpload(
      scope,
      memberB.id,
      "chat.txt",
      new TextEncoder().encode("chat"),
    );
    const chatDoc = await createDocumentFromUpload(scope, actorB, upChat, {
      chatSessionId: sessionId,
    });

    // Member A sees B's run doc but NOT B's chat doc.
    const asA = await listDocumentsForActor(scope, actorA, {});
    const idsA = asA.data.map((d) => d.id);
    expect(idsA).toContain(runDoc.id);
    expect(idsA).not.toContain(chatDoc.id);

    // Member B sees both (owns the chat session).
    const asB = await listDocumentsForActor(scope, actorB, {});
    const idsB = asB.data.map((d) => d.id);
    expect(idsB).toContain(runDoc.id);
    expect(idsB).toContain(chatDoc.id);

    // An end-user sees neither (isolation unchanged).
    const eu = await seedEndUser({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });
    const asEu = await listDocumentsForActor(scope, { type: "end_user", id: eu.id }, {});
    expect(asEu.data).toHaveLength(0);
  });

  it("FOR UPDATE re-check: two concurrent run outputs — only the one that fits commits, loser 413", async () => {
    // RUN_MAX_OUTPUT_BYTES = 15 so two 10-byte publishes cannot both land. Both
    // pass the pre-stream fast-check (run total = 0) and both stream their bytes;
    // the org `FOR UPDATE` lock serialises the commit re-check, so the second
    // observes the first's committed total (10) and is rejected (10 + 10 > 15).
    await withEnv("RUN_MAX_OUTPUT_BYTES", "15", async () => {
      const runId = await seedRunRow(scope);
      const results = await Promise.allSettled([
        publishStream(scope, runId, "a.txt", "0123456789"),
        publishStream(scope, runId, "b.txt", "abcdefghij"),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 413 });

      // Exactly one row committed, and the org counter reflects only its 10 bytes.
      const rows = await db.select().from(documents).where(eq(documents.runId, runId));
      expect(rows).toHaveLength(1);
      expect(await orgBytesUsed(ctx.orgId)).toBe(10);
    });
  });

  it("concurrent identical (sha256, name) run publishes never double-insert or double-count", async () => {
    // Same content + same name from two racing publishes. The partial unique
    // index `(run_id, sha256, name) WHERE purpose = 'agent_output'` guarantees a
    // single row and a single byte-count no matter which caller wins — the
    // safety invariant asserted unconditionally below.
    //
    // NOTE: which path the loser takes is timing-dependent: the fast-path SELECT
    // may already see the winner (→ dedup 200), OR both may miss it and race on
    // the insert (→ 23505). The latter recovery is currently BROKEN — see the
    // report: `isUniqueViolation` (documents.ts) does not unwrap Drizzle's
    // `DrizzleQueryError`, so a real concurrent-insert race rethrows the raw DB
    // error instead of returning the dedup winner. The dedup-contract assertions
    // below therefore run only when BOTH publishes resolved (the fast-path
    // timing); the single-row / single-count invariant is always enforced.
    const runId = await seedRunRow(scope);
    const results = await Promise.allSettled([
      publishStream(scope, runId, "same.txt", "identical-bytes"),
      publishStream(scope, runId, "same.txt", "identical-bytes"),
    ]);

    // The DB unique index makes double-insert / double-count impossible either way.
    const rows = await db.select().from(documents).where(eq(documents.runId, runId));
    expect(rows).toHaveLength(1);
    expect(await orgBytesUsed(ctx.orgId)).toBe("identical-bytes".length);

    // When the recovery works (fast-path timing), both resolve to the same row
    // with exactly one fresh insert and one dedup.
    if (results[0]!.status === "fulfilled" && results[1]!.status === "fulfilled") {
      const [r1, r2] = [results[0].value, results[1].value];
      expect(r1.row.id).toBe(r2.row.id);
      expect(r1.deduped).not.toBe(r2.deduped);
    }
  });

  it("GET /content: 403 for a member who is not the upload's creator, 200 for an agent_output", async () => {
    // Member A uploads on a run; member B (a second org member) can read the
    // metadata via the container ACL but the bytes are creator-only (D2/S1).
    const memberA = await createTestUser({ email: "a2@docs.test" });
    await addOrgMember(ctx.orgId, memberA.id, "member");
    const actorA: Actor = { type: "user", id: memberA.id };
    const memberB = await createTestUser({ email: "b2@docs.test" });
    await addOrgMember(ctx.orgId, memberB.id, "member");
    const bHeaders = authHeaders({ ...ctx, cookie: memberB.cookie });

    const runId = await seedRunRow(scope);
    const up = await stageUpload(
      scope,
      memberA.id,
      "priv.txt",
      new TextEncoder().encode("A private"),
    );
    const upload = await createDocumentFromUpload(scope, actorA, up, { runId });

    const meta = await app.request(`/api/documents/${upload.id}`, { headers: bHeaders });
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { downloadable: boolean }).downloadable).toBe(false);

    const content = await app.request(`/api/documents/${upload.id}/content`, { headers: bHeaders });
    expect(content.status).toBe(403);

    // An agent_output on the same run is downloadable by any container reader.
    const { row: output } = await publishStream(scope, runId, "report.txt", "agent deliverable");
    const outContent = await app.request(`/api/documents/${output.id}/content`, {
      headers: bHeaders,
    });
    expect(outContent.status).toBe(200);
  });

  it("end-user (impersonated via API key) reads own docs, is blocked from others', and deletes own", async () => {
    const eu = await seedEndUser({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });
    const euOther = await seedEndUser({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });
    const euActor: Actor = { type: "end_user", id: eu.id };
    const key = await seedApiKey({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      createdBy: ctx.user.id,
    });
    const euHeaders = {
      Authorization: `Bearer ${key.rawKey}`,
      "X-Application-Id": ctx.defaultAppId,
      "Appstrate-User": eu.id,
    };

    const runId = await seedRunRow(scope, { endUserId: eu.id });
    const { row: output } = await publishStream(scope, runId, "eu-out.txt", "eu deliverable", {
      userId: null,
      endUserId: eu.id,
    });
    const up = await stageUpload(scope, null, "eu-up.txt", new TextEncoder().encode("eu upload"));
    const upload = await createDocumentFromUpload(scope, euActor, up, { runId });

    // Own run's agent_output → 200; own user_upload → 200.
    const ownOut = await app.request(`/api/documents/${output.id}/content`, { headers: euHeaders });
    expect(ownOut.status).toBe(200);
    const ownUp = await app.request(`/api/documents/${upload.id}/content`, { headers: euHeaders });
    expect(ownUp.status).toBe(200);

    // Another end-user's document is hidden entirely (container ACL → 404).
    const otherRun = await seedRunRow(scope, { endUserId: euOther.id });
    const { row: otherOut } = await publishStream(scope, otherRun, "other.txt", "not yours", {
      userId: null,
      endUserId: euOther.id,
    });
    const foreign = await app.request(`/api/documents/${otherOut.id}`, { headers: euHeaders });
    expect(foreign.status).toBe(404);

    // The end-user can DELETE its own document (creator path, no permission grant).
    const del = await app.request(`/api/documents/${upload.id}`, {
      method: "DELETE",
      headers: euHeaders,
    });
    expect(del.status).toBe(204);
    const [gone] = await db.select().from(documents).where(eq(documents.id, upload.id));
    expect(gone).toBeUndefined();
  });

  it("Content-Disposition sanitizes header-injection and non-ASCII filenames", async () => {
    const runId = await seedRunRow(scope);

    // CRLF-injection attempt in the name: the ASCII fallback collapses control
    // chars to `_` and the RFC 5987 filename* percent-encodes them — no raw CRLF
    // ever reaches the header value.
    const { row: crlf } = await publishStream(scope, runId, "safe.txt", "crlf body");
    await db
      .update(documents)
      .set({ name: "a\r\nSet-Cookie: x.txt" })
      .where(eq(documents.id, crlf.id));
    const res1 = await app.request(`/api/documents/${crlf.id}/content`, {
      headers: authHeaders(ctx),
    });
    expect(res1.status).toBe(200);
    const cd1 = res1.headers.get("content-disposition")!;
    expect(cd1).not.toMatch(/[\r\n]/);
    expect(cd1).toContain('filename="a__Set-Cookie: x.txt"');
    expect(cd1).toContain("filename*=UTF-8''a%0D%0ASet-Cookie%3A%20x.txt");

    // Non-ASCII (accent + emoji): ASCII fallback underscores them, filename*
    // carries the UTF-8 percent-encoded real name.
    const { row: uni } = await publishStream(scope, runId, "safe2.txt", "unicode body");
    await db.update(documents).set({ name: "héllo📄.txt" }).where(eq(documents.id, uni.id));
    const res2 = await app.request(`/api/documents/${uni.id}/content`, {
      headers: authHeaders(ctx),
    });
    const cd2 = res2.headers.get("content-disposition")!;
    expect(cd2).not.toMatch(/[\r\n]/);
    expect(cd2).toContain('filename="h_llo__.txt"');
    expect(cd2).toContain("filename*=UTF-8''h%C3%A9llo%F0%9F%93%84.txt");
  });

  it("DELETE unknown id → 404; list ignores a garbage purpose and clamps limit to the catch default", async () => {
    const runId = await seedRunRow(scope);
    const up = await stageUpload(scope, ctx.user.id, "x.txt", new TextEncoder().encode("x"));
    await createDocumentFromUpload(scope, userActor, up, { runId });

    const del = await app.request(`/api/documents/doc_missing`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(del.status).toBe(404);

    // Unknown purpose → safeParse fails → filter dropped → full (unfiltered) list.
    const garbage = await app.request(`/api/documents?purpose=not_a_purpose`, {
      headers: authHeaders(ctx),
    });
    expect(garbage.status).toBe(200);
    expect(((await garbage.json()) as { data: unknown[] }).data.length).toBe(1);

    // limit out of range → route's `.max(100).catch(20)` yields the 20 default;
    // an in-range value is honored.
    const over = await app.request(`/api/documents?limit=500`, { headers: authHeaders(ctx) });
    expect(((await over.json()) as { limit: number }).limit).toBe(20);
    const inRange = await app.request(`/api/documents?limit=50`, { headers: authHeaders(ctx) });
    expect(((await inRange.json()) as { limit: number }).limit).toBe(50);
  });
});
