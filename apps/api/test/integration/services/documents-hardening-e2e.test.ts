// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-phase interaction tests for the documents-hardening effort (tier0, FS
 * storage). The per-phase suites (documents.test.ts, storage-deletion.test.ts,
 * organizations quota tests, uploads.test.ts) each cover one seam in isolation;
 * these exercise the INTERACTIONS between them that no single phase test could:
 *
 *  a. quota exhaustion DURING agent-output ingestion + the terminal artifacts
 *     summary that records the loss (phase 2 × 5), with the run still success;
 *  b. a mid-flight downgrade (limit set below used) leaving reads/list/delete
 *     working while new writes are refused, then freed by a delete (phase 5);
 *  c. the deletion outbox draining a churn of create+delete under a FLAKY
 *     storage backend — every job eventually completes, nothing stranded
 *     (phase 3), driven deterministically via injected deps (no sleeps);
 *  d. a concurrent org-limit race on the run-INGESTION path (createDocumentFrom
 *     Stream), not just the upload path the phase-5 test covers (phase 5);
 *  e. the display-name vs workspace-name identity model round-tripping through
 *     input materialization AND output publication (phase 1 × 2);
 *  f. the unified capability model degrading a non-creator upload read across
 *     the MCP resources/read path — no real name/hash leaks (phase 4 × 6).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { documents, organizations, runs, uploads, storageDeletionJobs } from "@appstrate/db/schema";
import { uploadStream } from "@appstrate/db/storage";
import { _resetCacheForTesting } from "@appstrate/env";
import type { Actor } from "@appstrate/connect";
import { emptyRunResult } from "@appstrate/afps-runtime/runner";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  addOrgMember,
  type TestContext,
} from "../../helpers/auth.ts";
import { createUpload } from "../../../src/services/uploads.ts";
import {
  createDocumentFromUpload,
  createDocumentFromStream,
  getDocumentForActor,
  listDocumentsForActor,
  deleteDocument,
  setOrgDocumentStorageLimit,
  streamDocumentContent,
} from "../../../src/services/documents.ts";
import { assignWorkspaceNames } from "../../../src/services/run-document-naming.ts";
import { processStorageDeletionJobs } from "../../../src/services/storage-deletion.ts";
import { finalizeRun, getRunSinkContext } from "../../../src/services/run-event-ingestion.ts";
import {
  buildDocumentResourceProvider,
  type McpToolContext,
} from "../../../src/modules/mcp/tools.ts";

type Scope = { orgId: string; applicationId: string };

// The documents resource provider's `read` ignores the MCP request-extra (it
// resolves auth from the injected ctx.actor); a stub satisfies the interface.
type ReadExtra = Parameters<ReturnType<typeof buildDocumentResourceProvider>["read"]>[1];
const NO_EXTRA = {} as ReadExtra;

/** Run `fn` with an env var temporarily overridden (env cache reset around it). */
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

/** Stage an upload row + write its bytes into the uploads bucket (FS). */
async function stageUpload(
  scope: Scope,
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

/** Seed a `running` run with a sink secret so `finalizeRun` can converge it. */
async function seedRunRow(scope: Scope, extra: { input?: Record<string, unknown> } = {}) {
  const id = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(runs).values({
    id,
    orgId: scope.orgId,
    applicationId: scope.applicationId,
    status: "running",
    input: extra.input ?? null,
    runOrigin: "platform",
    sinkSecretEncrypted: "test-sink-secret",
    sinkExpiresAt: new Date(Date.now() + 3_600_000),
    startedAt: new Date(),
    // Non-zero usage so finalize's zero-token heuristic does not flip success.
    tokenUsage: { input_tokens: 10, output_tokens: 5 },
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

/** Publish an `agent_output` from a run's streaming channel. */
function publishStream(scope: Scope, runId: string, name: string, content: string) {
  return createDocumentFromStream(scope, runId, { userId: null, endUserId: null }, null, {
    name,
    mime: "text/plain",
    body: new Blob([new TextEncoder().encode(content)]).stream(),
  });
}

describe("documents hardening — cross-phase interactions", () => {
  let ctx: TestContext;
  let scope: Scope;
  let userActor: Actor;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "hardening" });
    scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    userActor = { type: "user", id: ctx.user.id };
  });

  // ── a. quota hit during artifact ingestion + partial summary (phase 2 × 5) ──
  it("quota exhaustion mid-ingestion: 1st doc stored, 2nd/3rd rejected 403, run finalizes success with a partial summary", async () => {
    // 100-byte docs, limit 150 → doc1 fits (used 0→100), doc2/doc3 overrun.
    const body = "A".repeat(100);
    await withEnv("ORG_STORAGE_QUOTA_BYTES", "150", async () => {
      const runId = await seedRunRow(scope);

      const first = await publishStream(scope, runId, "out-1.txt", body);
      expect(first.deduped).toBe(false);
      expect(await orgBytesUsed(ctx.orgId)).toBe(100);

      // 2nd + 3rd (each genuinely new, distinct name) overrun the 150-byte limit.
      for (const name of ["out-2.txt", "out-3.txt"]) {
        await expect(publishStream(scope, runId, name, body)).rejects.toMatchObject({
          status: 403,
          code: "storage_limit_exceeded",
        });
      }
      // Exactly the one that fit was committed; the failed writes stranded nothing.
      const rows = await db.select().from(documents).where(eq(documents.runId, runId));
      expect(rows).toHaveLength(1);
      expect(await orgBytesUsed(ctx.orgId)).toBe(100);

      // The container reports the loss via the terminal artifacts summary; the
      // run itself still succeeds. Drive the real finalize convergence.
      const run = await getRunSinkContext(runId);
      expect(run).not.toBeNull();
      const result = emptyRunResult();
      result.status = "success";
      result.output = { ok: true };
      // Non-zero terminal usage so finalize's "never reached the LLM" heuristic
      // does not flip an otherwise-successful run to failed.
      result.usage = { input_tokens: 10, output_tokens: 5 };
      result.artifacts = {
        status: "partial",
        published: 1,
        failed: [
          { name: "out-2.txt", code: "quota_exceeded" },
          { name: "out-3.txt", code: "quota_exceeded" },
        ],
      };
      await finalizeRun({ run: run!, result });

      const [finalRow] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
      expect(finalRow?.status).toBe("success");
      expect(finalRow?.artifacts).toEqual({
        status: "partial",
        published: 1,
        failed: [
          { name: "out-2.txt", code: "quota_exceeded" },
          { name: "out-3.txt", code: "quota_exceeded" },
        ],
      });
    });
  });

  // ── b. downgrade under load: reads/list/delete keep working (phase 5) ──
  it("downgrade below used: list/download/delete keep working while new writes are refused, delete frees, write works again", async () => {
    const runId = await seedRunRow(scope);
    // Two 100-byte agent outputs under a generous limit.
    await withEnv("ORG_STORAGE_QUOTA_BYTES", "1000", async () => {
      await publishStream(scope, runId, "keep-1.txt", "A".repeat(100));
      await publishStream(scope, runId, "keep-2.txt", "B".repeat(100));
    });
    expect(await orgBytesUsed(ctx.orgId)).toBe(200);

    // Downgrade the org limit BELOW current usage (200 used, limit now 150).
    await setOrgDocumentStorageLimit(ctx.orgId, 150);

    const [doc1] = await db.select().from(documents).where(eq(documents.name, "keep-1.txt"));

    // Existing content stays fully readable (list, resolve, download) over-limit.
    const listed = await listDocumentsForActor(scope, userActor, { runId });
    expect(listed.data).toHaveLength(2);
    const resolved = await getDocumentForActor(scope, userActor, doc1!.id);
    expect(resolved?.capabilities.download).toBe(true);
    const stream = await streamDocumentContent(doc1!.storageKey);
    expect(stream).not.toBeNull();
    expect((await new Response(stream!).text()).length).toBe(100);

    // A new write is refused while over the (lowered) limit (used 200 > 150).
    await expect(publishStream(scope, runId, "new.txt", "C".repeat(100))).rejects.toMatchObject({
      status: 403,
      code: "storage_limit_exceeded",
    });

    // Deleting one 100-byte doc frees room (used 100); a 50-byte write now fits
    // exactly on the 150-byte limit (equality is allowed).
    await deleteDocument(scope, doc1!.id);
    expect(await orgBytesUsed(ctx.orgId)).toBe(100);
    const created = await publishStream(scope, runId, "new.txt", "C".repeat(50));
    expect(created.deduped).toBe(false);
    expect(await orgBytesUsed(ctx.orgId)).toBe(150);
  });

  // ── c. deletion outbox under churn with a flaky backend (phase 3) ──
  it("deletion outbox drains a create+delete churn under a flaky deleteFile — every job eventually completes, nothing stranded", async () => {
    const runId = await seedRunRow(scope);
    const N = 5;
    const created = [];
    for (let i = 0; i < N; i++) {
      created.push(await publishStream(scope, runId, `churn-${i}.txt`, `payload-${i}`));
    }
    // Deleting each enqueues a storage-deletion job atomically (transactional
    // outbox). The counter is decremented at row-delete time, not purge time.
    for (const c of created) await deleteDocument(scope, c.row.id);
    expect(await orgBytesUsed(ctx.orgId)).toBe(0);

    const pendingBefore = await db
      .select()
      .from(storageDeletionJobs)
      .where(isNull(storageDeletionJobs.completedAt));
    expect(pendingBefore).toHaveLength(N);

    // Flaky backend: the first 3 physical deletes throw, the rest succeed. rand
    // = 0 makes backoff deterministic (still parks a failed job forward).
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls <= 3) throw new Error("transient storage outage");
    };
    const pass1 = await processStorageDeletionJobs({ deleteFile: flaky, rand: () => 0 });
    expect(pass1.claimed).toBe(N);
    expect(pass1.completed).toBe(N - 3);
    expect(pass1.failed).toBe(3);

    // Simulate the backoff window elapsing (the periodic worker would wake once
    // next_attempt_at passes) so the parked jobs are due again — no sleep.
    await db
      .update(storageDeletionJobs)
      .set({ nextAttemptAt: new Date() })
      .where(isNull(storageDeletionJobs.completedAt));

    // Second pass: the flaky counter is past its failure budget → all succeed.
    const pass2 = await processStorageDeletionJobs({ deleteFile: flaky, rand: () => 0 });
    expect(pass2.completed).toBe(3);
    expect(pass2.failed).toBe(0);

    const pendingAfter = await db
      .select()
      .from(storageDeletionJobs)
      .where(isNull(storageDeletionJobs.completedAt));
    expect(pendingAfter).toHaveLength(0);
    // The full set was purged exactly once each (3 failed retries + 5 successes).
    expect(calls).toBe(N + 3);
  });

  // ── d. concurrent org-limit race on the ingestion path (phase 5) ──
  it("two concurrent run-output publishes race the org limit — exactly one commits, the counter stays exact", async () => {
    const runId = await seedRunRow(scope);
    // Room for exactly one 100-byte output (limit 100, used 0). Both publishes
    // pass their (empty) dedup SELECT, then serialize on the org FOR UPDATE lock
    // inside commitDocumentRow — the loser's re-check trips 403.
    await withEnv("ORG_STORAGE_QUOTA_BYTES", "100", async () => {
      const results = await Promise.allSettled([
        publishStream(scope, runId, "race-a.txt", "A".repeat(100)),
        publishStream(scope, runId, "race-b.txt", "B".repeat(100)),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        status: 403,
        code: "storage_limit_exceeded",
      });
    });
    // Exactly one row, counter equals its size — no double-count.
    const rows = await db.select().from(documents).where(eq(documents.runId, runId));
    expect(rows).toHaveLength(1);
    expect(await orgBytesUsed(ctx.orgId)).toBe(100);
  });

  // ── e. display-name vs workspace-name identity model (phase 1 × 2) ──
  it("same-named inputs keep distinct docs + unique workspace names; same-named outputs split by content, dedup on identical", async () => {
    const runId = await seedRunRow(scope);

    // Two INPUT uploads with the SAME display name are both legal, distinct docs.
    const u1 = await stageUpload(scope, ctx.user.id, "report.txt", new TextEncoder().encode("one"));
    const u2 = await stageUpload(scope, ctx.user.id, "report.txt", new TextEncoder().encode("two"));
    const d1 = await createDocumentFromUpload(scope, userActor, u1, { runId });
    const d2 = await createDocumentFromUpload(scope, userActor, u2, { runId });
    expect(d1.name).toBe("report.txt");
    expect(d2.name).toBe("report.txt");
    expect(d1.id).not.toBe(d2.id);
    // The workspace-name derivation (phase 1) disambiguates the collision so the
    // two never overwrite each other when provisioned into the container.
    expect(assignWorkspaceNames(["report.txt", "report.txt"])).toEqual([
      "report.txt",
      "report-2.txt",
    ]);

    // Two OUTPUTS with the same name but DIFFERENT content → two distinct rows
    // (dedup key is (run, sha256, name), so different sha ⇒ not deduped).
    const outA = await publishStream(scope, runId, "out.txt", "content-A");
    const outB = await publishStream(scope, runId, "out.txt", "content-B");
    expect(outA.deduped).toBe(false);
    expect(outB.deduped).toBe(false);
    expect(outA.row.id).not.toBe(outB.row.id);
    expect(outA.row.sha256).not.toBe(outB.row.sha256);

    // Re-publishing the SAME (name, content) dedups back to the first row.
    const outAgain = await publishStream(scope, runId, "out.txt", "content-A");
    expect(outAgain.deduped).toBe(true);
    expect(outAgain.row.id).toBe(outA.row.id);

    const outs = await db
      .select()
      .from(documents)
      .where(and(eq(documents.runId, runId), eq(documents.name, "out.txt")));
    expect(outs).toHaveLength(2);
  });

  // ── f. capability degradation across the MCP resources/read path (phase 4 × 6) ──
  it("MCP resources/read of another member's upload is degraded (generic name/mime, no real hash); the creator gets the bytes", async () => {
    const creator = await createTestUser({ email: "mcp-creator@docs.test" });
    await addOrgMember(ctx.orgId, creator.id, "member");
    const creatorActor: Actor = { type: "user", id: creator.id };
    const reader = await createTestUser({ email: "mcp-reader@docs.test" });
    await addOrgMember(ctx.orgId, reader.id, "member");

    const runId = await seedRunRow(scope);
    const secretBytes = new TextEncoder().encode("top secret upload contents");
    const realSha = new Bun.CryptoHasher("sha256").update(secretBytes).digest("hex");
    const up = await stageUpload(scope, creator.id, "secret-notes.txt", secretBytes);
    const upload = await createDocumentFromUpload(scope, creatorActor, up, { runId });

    const mkCtx = (actor: Actor): McpToolContext => ({
      origin: "https://instance.example",
      authHeaders: new Headers(),
      permissions: new Set<string>(),
      actor,
      scope,
      dispatch: async () => new Response(null),
    });

    // Non-creator run reader → metadata-only, degraded: generic name + mime, NO
    // sha256, not downloadable, no content_url. The real name/hash never appear.
    const readerRes = await buildDocumentResourceProvider(
      mkCtx({ type: "user", id: reader.id }),
    ).read(`document://${upload.id}`, NO_EXTRA);
    const readerBlock = readerRes.contents[0] as { mimeType?: string; text?: string };
    const readerText = readerBlock.text!;
    const readerJson = JSON.parse(readerText) as {
      name: string;
      mime: string;
      sha256?: string;
      downloadable: boolean;
      content_url?: string;
      capabilities: { metadata: boolean; download: boolean };
    };
    expect(readerBlock.mimeType).toBe("application/json");
    expect(readerJson.name).toBe("document");
    expect(readerJson.mime).toBe("application/octet-stream");
    expect(readerJson.sha256).toBeUndefined();
    expect(readerJson.downloadable).toBe(false);
    expect(readerJson.content_url).toBeUndefined();
    expect(readerJson.capabilities).toMatchObject({ metadata: false, download: false });
    // Belt-and-braces: the real hash + real name leak NOWHERE in the response.
    expect(readerText).not.toContain(realSha);
    expect(readerText).not.toContain("secret-notes.txt");

    // The creator reads the actual bytes (small textual upload → inline text).
    const creatorRes = await buildDocumentResourceProvider(mkCtx(creatorActor)).read(
      `document://${upload.id}`,
      NO_EXTRA,
    );
    const creatorBlock = creatorRes.contents[0] as { mimeType?: string; text?: string };
    expect(creatorBlock.mimeType).toBe("text/plain");
    expect(creatorBlock.text).toBe("top secret upload contents");
  });
});
