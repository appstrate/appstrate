// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `consumeUploadStream` — exercise the multi-use consume
 * semantics (first-consume claim + post-consume reuse window), cross-tenant
 * isolation, the streamed size/MIME validation, and the expired/missing-binary
 * paths.
 *
 * Uses a real Postgres + filesystem storage; no routes exercised. The sink
 * mirrors production — `fileTypeStream` sniffs the head, a manual drain counts
 * the bytes — without writing to a run workspace, so the tests stay focused on
 * consume semantics.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { fileTypeStream } from "file-type";
import { zipSync } from "fflate";
import { db } from "@appstrate/db/client";
import { uploads, storageDeletionJobs } from "@appstrate/db/schema";
import { processStorageDeletionJobs } from "../../../src/services/storage-deletion.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";
import {
  consumeUploadStream,
  writeProxyUploadContent,
  cleanupExpiredUploads,
  type UploadStreamSink,
} from "../../../src/services/uploads.ts";
import {
  uploadFile as storagePut,
  downloadFile as storageGet,
  fileExists as storageExists,
} from "@appstrate/db/storage";
import { eq } from "drizzle-orm";
import { ApiError } from "../../../src/lib/errors.ts";

const UPLOAD_BUCKET = "uploads";
const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // %PDF-1.4\n

/**
 * Drain the upload stream the way the run-trigger sink does: sniff the MIME
 * from the head via `fileTypeStream`, count every byte. Reports the actual size
 * + sniffed MIME so consume can validate them against the declared upload row.
 */
const drainSink: UploadStreamSink = async (stream) => {
  const detection = await fileTypeStream(stream);
  let bytes = 0;
  const reader = detection.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
  }
  return { bytes, sniffedMime: detection.fileType?.mime };
};

async function seedUpload(
  ctx: { orgId: string; applicationId: string },
  opts: {
    id: string;
    bytes: Buffer;
    mime?: string;
    expiresInSec?: number;
    skipStoragePut?: boolean;
    sizeOverride?: number;
  },
): Promise<string> {
  const storagePath = `${ctx.applicationId}/${opts.id}/file.pdf`;
  const storageKey = `${UPLOAD_BUCKET}/${storagePath}`;
  if (!opts.skipStoragePut) {
    await storagePut(UPLOAD_BUCKET, storagePath, opts.bytes);
  }
  await db.insert(uploads).values({
    id: opts.id,
    orgId: ctx.orgId,
    applicationId: ctx.applicationId,
    createdBy: null,
    storageKey,
    name: "file.pdf",
    mime: opts.mime ?? "application/pdf",
    size: opts.sizeOverride ?? opts.bytes.length,
    expiresAt: new Date(Date.now() + (opts.expiresInSec ?? 900) * 1000),
  });
  return opts.id;
}

describe("consumeUploadStream", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("concurrent consume of the same upload: both succeed (multi-use)", async () => {
    const ctx = await createTestContext({ orgSlug: "org-race" });
    const id = "upl_race_1";
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes: PDF_BYTES },
    );

    const settled = await Promise.allSettled([
      consumeUploadStream(id, { orgId: ctx.orgId, applicationId: ctx.defaultAppId }, drainSink),
      consumeUploadStream(id, { orgId: ctx.orgId, applicationId: ctx.defaultAppId }, drainSink),
    ]);
    // Every consumer streams the same immutable object — no loser.
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(2);
  });

  it("a second sequential consume succeeds within the reuse window (#634)", async () => {
    const ctx = await createTestContext({ orgSlug: "org-seq" });
    const id = "upl_seq_1";
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes: PDF_BYTES },
    );
    const first = await consumeUploadStream(
      id,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      drainSink,
    );
    const [afterFirst] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);

    const second = await consumeUploadStream(
      id,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      drainSink,
    );
    expect(second).toEqual(first);

    // consumedAt anchors the reuse window at the FIRST consume — never bumped.
    const [afterSecond] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    expect(afterSecond?.consumedAt).toEqual(afterFirst!.consumedAt!);
  });

  it("re-consume works even after the PUT-window expiry (cancel → re-run)", async () => {
    const ctx = await createTestContext({ orgSlug: "org-reuse-expired" });
    const id = "upl_reuse_expired_1";
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes: PDF_BYTES },
    );
    await consumeUploadStream(id, { orgId: ctx.orgId, applicationId: ctx.defaultAppId }, drainSink);
    // Simulate the re-trigger arriving after the 15-min PUT window closed.
    await db
      .update(uploads)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(uploads.id, id));

    const meta = await consumeUploadStream(
      id,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      drainSink,
    );
    expect(meta.size).toBe(PDF_BYTES.length);
  });

  it("re-consume after the reuse window has elapsed reports 410 gone", async () => {
    const ctx = await createTestContext({ orgSlug: "org-reuse-gone" });
    const id = "upl_reuse_gone_1";
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes: PDF_BYTES },
    );
    // Consumed 25h ago — outside the 24h default reuse window.
    await db
      .update(uploads)
      .set({ consumedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(uploads.id, id));
    try {
      await consumeUploadStream(
        id,
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        drainSink,
      );
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(410);
    }
  });

  it("re-consume of another tenant's consumed upload reports not-found", async () => {
    const owner = await createTestContext({ orgSlug: "org-reuse-owner" });
    const other = await createTestContext({ orgSlug: "org-reuse-other" });
    const id = "upl_reuse_cross_1";
    await seedUpload(
      { orgId: owner.orgId, applicationId: owner.defaultAppId },
      { id, bytes: PDF_BYTES },
    );
    await consumeUploadStream(
      id,
      { orgId: owner.orgId, applicationId: owner.defaultAppId },
      drainSink,
    );
    try {
      await consumeUploadStream(
        id,
        { orgId: other.orgId, applicationId: other.defaultAppId },
        drainSink,
      );
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(404);
    }
  });

  it("cross-org consume reports not-found (hides existence)", async () => {
    const owner = await createTestContext({ orgSlug: "org-owner" });
    const other = await createTestContext({ orgSlug: "org-other" });
    const id = "upl_cross_1";
    await seedUpload(
      { orgId: owner.orgId, applicationId: owner.defaultAppId },
      { id, bytes: PDF_BYTES },
    );
    try {
      await consumeUploadStream(
        id,
        { orgId: other.orgId, applicationId: other.defaultAppId },
        drainSink,
      );
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(404);
    }
  });

  it("expired upload reports 410 gone", async () => {
    const ctx = await createTestContext({ orgSlug: "org-expired" });
    const id = "upl_expired_1";
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes: PDF_BYTES, expiresInSec: -10 },
    );
    try {
      await consumeUploadStream(
        id,
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        drainSink,
      );
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(410);
    }
  });

  it("size mismatch is rejected (prevents declared-small / uploaded-huge abuse)", async () => {
    const ctx = await createTestContext({ orgSlug: "org-size" });
    const id = "upl_size_1";
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes: PDF_BYTES, sizeOverride: 1 },
    );
    try {
      await consumeUploadStream(
        id,
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        drainSink,
      );
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message).toContain("size mismatch");
    }
  });

  it("missing storage binary reports a clear 400", async () => {
    const ctx = await createTestContext({ orgSlug: "org-missing" });
    const id = "upl_missing_1";
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes: PDF_BYTES, skipStoragePut: true },
    );
    try {
      await consumeUploadStream(
        id,
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        drainSink,
      );
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
    }
  });

  it("text/plain upload is accepted even when file-type cannot sniff it", async () => {
    const ctx = await createTestContext({ orgSlug: "org-text" });
    const id = "upl_text_1";
    const bytes = Buffer.from("hello world\n", "utf-8");
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes, mime: "text/plain" },
    );
    const consumed = await consumeUploadStream(
      id,
      {
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
      },
      drainSink,
    );
    expect(consumed.size).toBe(bytes.length);
    expect(consumed.mime).toBe("text/plain");
  });

  it("declared-pdf but text bytes is rejected on magic-byte sniffing", async () => {
    const ctx = await createTestContext({ orgSlug: "org-spoof" });
    const id = "upl_spoof_1";
    const bytes = Buffer.from("this is not a pdf", "utf-8");
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes, mime: "application/pdf" },
    );
    try {
      await consumeUploadStream(
        id,
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        drainSink,
      );
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message.toLowerCase()).toContain("mime");
    }
  });

  it("xlsx whose head sniffs as application/zip is accepted (#zip-container refinement)", async () => {
    // Mirror the openpyxl/LibreOffice OOXML layout: content entries first,
    // `[Content_Types].xml` LAST. The big stored entry pushes the identifying
    // entry past `fileTypeStream`'s ~4100-byte sample, so the sniffer falls
    // back to plain `application/zip` — which must refine into the declared
    // spreadsheet type instead of failing the consume.
    const ctx = await createTestContext({ orgSlug: "org-xlsx" });
    const id = "upl_xlsx_1";
    const enc = new TextEncoder();
    // Incompressible pseudo-random payload (deterministic LCG) — keeps the
    // deflated sheet entry well past the sniffer's sample window, like the
    // real-world spreadsheet data this reproduces.
    const sheetData = new Uint8Array(20000);
    let seed = 0x12345678;
    for (let i = 0; i < sheetData.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      sheetData[i] = seed & 0xff;
    }
    const bytes = Buffer.from(
      zipSync({
        "docProps/app.xml": enc.encode(`<x>${"a".repeat(150)}</x>`),
        "xl/worksheets/sheet1.xml": sheetData,
        "[Content_Types].xml": enc.encode(
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
        ),
      }),
    );
    const declared = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes, mime: declared },
    );
    const consumed = await consumeUploadStream(
      id,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      drainSink,
    );
    expect(consumed.size).toBe(bytes.length);
    expect(consumed.mime).toBe(declared);
  });

  it("legacy .xls (OLE2/CFB container) declared as ms-excel is accepted", async () => {
    // file-type identifies the OLE2 magic as generic application/x-cfb and
    // never refines it to the concrete legacy Office format — parent↔child
    // refinement must bridge the gap, same as the ZIP family.
    const ctx = await createTestContext({ orgSlug: "org-xls" });
    const id = "upl_xls_1";
    const cfb = new Uint8Array(512);
    cfb.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const bytes = Buffer.from(cfb);
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes, mime: "application/vnd.ms-excel" },
    );
    const consumed = await consumeUploadStream(
      id,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      drainSink,
    );
    expect(consumed.size).toBe(bytes.length);
    expect(consumed.mime).toBe("application/vnd.ms-excel");
  });

  it("zip bytes declared as pdf are still rejected (family refinement is zip-only)", async () => {
    const ctx = await createTestContext({ orgSlug: "org-zip-spoof" });
    const id = "upl_zip_spoof_1";
    const bytes = Buffer.from(zipSync({ "a.txt": new TextEncoder().encode("hi") }));
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes, mime: "application/pdf" },
    );
    try {
      await consumeUploadStream(
        id,
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        drainSink,
      );
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message).toContain("does not match declared");
    }
  });

  it("releases the claim after a post-claim failure so the client can retry", async () => {
    const ctx = await createTestContext({ orgSlug: "org-rollback" });
    const id = "upl_rollback_1";
    // Size mismatch is a deterministic post-claim failure path.
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes: PDF_BYTES, sizeOverride: PDF_BYTES.length + 1 },
    );
    try {
      await consumeUploadStream(
        id,
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        drainSink,
      );
      throw new Error("expected to throw");
    } catch (e) {
      expect((e as ApiError).status).toBe(400);
    }
    // Row should be re-consumable — consumedAt was rolled back.
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    expect(row?.consumedAt).toBeNull();
  });

  it("retains the storage object after a successful consume (reuse source)", async () => {
    const ctx = await createTestContext({ orgSlug: "org-cleanup-ok" });
    const id = "upl_cleanup_ok_1";
    const storagePath = `${ctx.defaultAppId}/${id}/file.pdf`;
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes: PDF_BYTES },
    );
    expect(await storageExists(UPLOAD_BUCKET, storagePath)).toBe(true);

    await consumeUploadStream(id, { orgId: ctx.orgId, applicationId: ctx.defaultAppId }, drainSink);

    // Object + row survive the consume — they back the post-consume reuse
    // window and are dropped by the GC sweep once it elapses.
    expect(await storageExists(UPLOAD_BUCKET, storagePath)).toBe(true);
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    expect(row?.consumedAt).not.toBeNull();
  });

  it("deletes the storage object after a post-claim failure (release path)", async () => {
    const ctx = await createTestContext({ orgSlug: "org-cleanup-err" });
    const id = "upl_cleanup_err_1";
    const storagePath = `${ctx.defaultAppId}/${id}/file.pdf`;
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes: PDF_BYTES, sizeOverride: PDF_BYTES.length + 1 },
    );
    expect(await storageExists(UPLOAD_BUCKET, storagePath)).toBe(true);

    await consumeUploadStream(
      id,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      drainSink,
    ).catch(() => {});

    // Release path drops the bytes so re-upload to a fresh slot can succeed.
    expect(await storageExists(UPLOAD_BUCKET, storagePath)).toBe(false);
  });
});

describe("cleanupExpiredUploads", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("sweeps consumed rows older than the 24h retention window", async () => {
    const ctx = await createTestContext({ orgSlug: "org-gc-consumed" });
    const id = "upl_gc_old_1";
    const storagePath = `${ctx.defaultAppId}/${id}/file.pdf`;
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes: PDF_BYTES },
    );
    // Simulate a row consumed > 24h ago (retention window is 24h).
    const oldTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db.update(uploads).set({ consumedAt: oldTimestamp }).where(eq(uploads.id, id));

    const removed = await cleanupExpiredUploads();
    expect(removed).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    expect(row).toBeUndefined();
    // The sweep is the deleter of record for the retained reuse bytes — but now
    // via the transactional deletion outbox: the row delete + deletion-job insert
    // are one transaction (no silent orphan), and the worker purges the object.
    const jobs = await db
      .select()
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.storageKey, storagePath));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.bucket).toBe(UPLOAD_BUCKET);
    expect(jobs[0]!.reason).toBe("upload_expired");
    // Still present until the worker drains; then gone.
    expect(await storageExists(UPLOAD_BUCKET, storagePath)).toBe(true);
    await processStorageDeletionJobs();
    expect(await storageExists(UPLOAD_BUCKET, storagePath)).toBe(false);
  });

  it("keeps consumed rows still within the retention window", async () => {
    const ctx = await createTestContext({ orgSlug: "org-gc-recent" });
    const id = "upl_gc_recent_1";
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes: PDF_BYTES },
    );
    // Consumed 1h ago — well within the 24h window.
    const recentTimestamp = new Date(Date.now() - 60 * 60 * 1000);
    await db.update(uploads).set({ consumedAt: recentTimestamp }).where(eq(uploads.id, id));

    await cleanupExpiredUploads();

    const [row] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    expect(row).toBeDefined();
    expect(row?.consumedAt).not.toBeNull();
  });

  it("still sweeps expired unconsumed rows (regression on base case)", async () => {
    const ctx = await createTestContext({ orgSlug: "org-gc-expired" });
    const id = "upl_gc_expired_1";
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes: PDF_BYTES, expiresInSec: -60 },
    );

    const removed = await cleanupExpiredUploads();
    expect(removed).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    expect(row).toBeUndefined();
  });
});

describe("writeProxyUploadContent (FS sink)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  /** Body stream from raw bytes — mirrors `c.req.raw.body` in the route. */
  const bodyStream = (bytes: Uint8Array): ReadableStream<Uint8Array> => new Response(bytes).body!;

  /** Unique path per test run — `truncateAll()` only resets the DB, not storage. */
  const uniqueKey = (label: string): { key: string; storagePath: string } => {
    const unique = `upl_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const storagePath = `sink-test/${unique}/file.bin`;
    return { key: `${UPLOAD_BUCKET}/${storagePath}`, storagePath };
  };

  it("refuses to overwrite an existing object at the same storage key", async () => {
    const { key, storagePath } = uniqueKey("replay");
    await writeProxyUploadContent(key, bodyStream(new Uint8Array([1, 2, 3])), 0);
    // Second PUT with the same (still-valid) token must be rejected.
    try {
      await writeProxyUploadContent(key, bodyStream(new Uint8Array([4, 5, 6])), 0);
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(409);
    }
    // Original bytes preserved.
    const stored = await storageGet(UPLOAD_BUCKET, storagePath);
    expect(stored).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("accepts a body at exactly the signed max and reports its size", async () => {
    const { key, storagePath } = uniqueKey("exact");
    const bytes = new Uint8Array(64).fill(7);
    const result = await writeProxyUploadContent(key, bodyStream(bytes), 64);
    expect(result.size).toBe(64);
    expect(await storageGet(UPLOAD_BUCKET, storagePath)).toEqual(bytes);
  });

  it("aborts mid-stream once the byte count exceeds the signed max (chunked — no Content-Length)", async () => {
    const { key, storagePath } = uniqueKey("oversize");
    // Multi-chunk source with no length known up front — the shape of a
    // chunked-transfer-encoding request that bypasses Content-Length checks.
    const chunk = new Uint8Array(1024).fill(1);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 8; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    try {
      await writeProxyUploadContent(key, source, 4 * 1024);
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message).toContain("exceeds signed max");
    }
    // No partial object left behind — the token stays usable for a clean
    // retry (at the exact signed size: `s` binds the declared byte count).
    expect(await storageExists(UPLOAD_BUCKET, storagePath)).toBe(false);
    const retry = new Uint8Array(4 * 1024).fill(9);
    await writeProxyUploadContent(key, bodyStream(retry), 4 * 1024);
    expect(await storageGet(UPLOAD_BUCKET, storagePath)).toEqual(retry);
  });

  it("rejects a completed body SHORTER than the signed size and rolls back (token reusable)", async () => {
    // Exact-size binding — parity with direct-presign S3 mode, which signs
    // Content-Length into the presigned PUT (and with S3 presigned-POST's
    // content-length-range). A truncated upload must fail HERE, not later at
    // consume time, and must leave no object so the same token can retry.
    const { key, storagePath } = uniqueKey("short");
    try {
      await writeProxyUploadContent(key, bodyStream(new Uint8Array(48).fill(5)), 64);
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message).toContain("signed size");
    }
    expect(await storageExists(UPLOAD_BUCKET, storagePath)).toBe(false);
    const retry = new Uint8Array(64).fill(6);
    await writeProxyUploadContent(key, bodyStream(retry), 64);
    expect(await storageGet(UPLOAD_BUCKET, storagePath)).toEqual(retry);
  });

  it("treats a signed max of 0 as unlimited (legacy tokens)", async () => {
    const { key, storagePath } = uniqueKey("nolimit");
    const bytes = new Uint8Array(2048).fill(3);
    await writeProxyUploadContent(key, bodyStream(bytes), 0);
    expect(await storageGet(UPLOAD_BUCKET, storagePath)).toEqual(bytes);
  });

  it("enforces the token expiry WHILE the body streams, not just at PUT start", async () => {
    // Slow-loris guard: the route validates expiry when the PUT starts; the
    // counting transform re-checks it per chunk so a trickled body cannot
    // hold the socket (and an open S3 multipart upload) past the window.
    // An already-past expiry makes the very first chunk trip the check
    // without any real-time waiting.
    const { key, storagePath } = uniqueKey("expired");
    const pastExpiry = Math.floor(Date.now() / 1000) - 1;
    try {
      await writeProxyUploadContent(key, bodyStream(new Uint8Array(64).fill(4)), 64, pastExpiry);
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(401);
      expect((e as ApiError).message).toContain("expired");
    }
    // Rolled back — nothing written.
    expect(await storageExists(UPLOAD_BUCKET, storagePath)).toBe(false);
  });

  it("concurrent PUTs with the same token: exactly one wins, state stays consistent", async () => {
    // Replay/race protection under true concurrency (O_EXCL on FS,
    // `If-None-Match: *` on S3): exactly one body must land, the loser must
    // report the replay conflict, and the stored object must be one of the
    // two payloads in full — never interleaved or partial.
    const { key, storagePath } = uniqueKey("race");
    const a = new Uint8Array(1024).fill(1);
    const b = new Uint8Array(1024).fill(2);
    const results = await Promise.allSettled([
      writeProxyUploadContent(key, bodyStream(a), 1024),
      writeProxyUploadContent(key, bodyStream(b), 1024),
    ]);
    const winners = results.filter((r) => r.status === "fulfilled");
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0]!.reason).toBeInstanceOf(ApiError);
    expect((losers[0]!.reason as ApiError).status).toBe(409);
    const stored = await storageGet(UPLOAD_BUCKET, storagePath);
    expect(stored).not.toBeNull();
    expect(stored!.length).toBe(1024);
    expect([1, 2]).toContain(stored![0]!);
    expect(stored!.every((byte) => byte === stored![0])).toBe(true);
  });
});
