// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for Phase 6 upload hardening:
 *  - ownership gate on peek/consume (a non-creator is a 404),
 *  - client SHA-256 integrity (proxy-sink verify + consume-time verify),
 *  - the createUpload staging budget (per-actor active count, per-org bytes).
 *
 * Real Postgres + filesystem storage; the consume sink hashes like production
 * so the checksum path is exercised end-to-end.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { uploads } from "@appstrate/db/schema";
import { _resetCacheForTesting } from "@appstrate/env";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedEndUser } from "../../helpers/seed.ts";
import {
  createUpload,
  consumeUploadStream,
  peekUploads,
  writeProxyUploadContent,
  type UploadStreamSink,
} from "../../../src/services/uploads.ts";
import {
  uploadFile as storagePut,
  fileExists as storageExists,
  downloadStream as storageDownload,
} from "@appstrate/db/storage";
import type { Actor } from "@appstrate/connect";

const UPLOAD_BUCKET = "uploads";
const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // %PDF-1.4\n

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Consume sink that hashes + counts like the run-workspace / materialize sinks. */
const hashingSink: UploadStreamSink = async (stream) => {
  const hasher = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    hasher.update(value);
  }
  return { bytes, sniffedMime: undefined, sha256: hasher.digest("hex") };
};

async function seedUpload(
  ctx: { orgId: string; applicationId: string },
  opts: {
    id: string;
    createdBy?: string | null;
    endUserId?: string | null;
    sha256?: string | null;
    bytes?: Buffer;
    mime?: string;
  },
): Promise<string> {
  const bytes = opts.bytes ?? PDF_BYTES;
  const storagePath = `${ctx.applicationId}/${opts.id}/file.pdf`;
  await storagePut(UPLOAD_BUCKET, storagePath, bytes);
  await db.insert(uploads).values({
    id: opts.id,
    orgId: ctx.orgId,
    applicationId: ctx.applicationId,
    createdBy: opts.createdBy ?? null,
    endUserId: opts.endUserId ?? null,
    sha256: opts.sha256 ?? null,
    storageKey: `${UPLOAD_BUCKET}/${storagePath}`,
    name: "file.pdf",
    mime: opts.mime ?? "application/octet-stream",
    size: bytes.length,
    expiresAt: new Date(Date.now() + 900 * 1000),
  });
  return opts.id;
}

async function withEnv(entries: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(entries)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  _resetCacheForTesting();
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetCacheForTesting();
  }
}

describe("upload ownership gate (peek + consume)", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "own" });
  });

  it("a non-creator same-org actor is rejected as not-found; the creator succeeds", async () => {
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const creator: Actor = { type: "user", id: ctx.user.id };
    const stranger: Actor = { type: "user", id: "u_stranger" };
    await seedUpload(scope, { id: "upl_own_1", createdBy: ctx.user.id });

    // peek — stranger 404
    await expect(peekUploads(["upl_own_1"], { ...scope, actor: stranger })).rejects.toMatchObject({
      status: 404,
    });

    // consume — stranger 404, and the upload is NOT claimed (bytes intact)
    await expect(
      consumeUploadStream("upl_own_1", { ...scope, actor: stranger }, hashingSink),
    ).rejects.toMatchObject({ status: 404 });
    const [afterStranger] = await db.select().from(uploads).where(eq(uploads.id, "upl_own_1"));
    expect(afterStranger!.consumedAt).toBeNull();

    // creator peek + consume succeed
    const metas = await peekUploads(["upl_own_1"], { ...scope, actor: creator });
    expect(metas.get("upl_own_1")).toBeDefined();
    const meta = await consumeUploadStream("upl_own_1", { ...scope, actor: creator }, hashingSink);
    expect(meta.size).toBe(PDF_BYTES.length);
  });

  it("an end-user creator is matched by endUserId, not createdBy", async () => {
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const aliceEu = await seedEndUser({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });
    const bobEu = await seedEndUser({ orgId: ctx.orgId, applicationId: ctx.defaultAppId });
    await seedUpload(scope, { id: "upl_eu_1", endUserId: aliceEu.id });
    const alice: Actor = { type: "end_user", id: aliceEu.id };
    const bob: Actor = { type: "end_user", id: bobEu.id };

    await expect(peekUploads(["upl_eu_1"], { ...scope, actor: bob })).rejects.toMatchObject({
      status: 404,
    });
    expect((await peekUploads(["upl_eu_1"], { ...scope, actor: alice })).size).toBe(1);
  });
});

describe("upload SHA-256 integrity", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "sha" });
  });

  it("proxy sink accepts matching bytes and rejects a mismatch (no visible object)", async () => {
    const good = new Uint8Array([1, 2, 3, 4, 5]);
    const path = `${ctx.defaultAppId}/upl_sha_ok/blob`;
    const key = `${UPLOAD_BUCKET}/${path}`;
    await writeProxyUploadContent(
      key,
      new Blob([good]).stream(),
      good.byteLength,
      0,
      sha256Hex(good),
    );
    expect(await storageExists(UPLOAD_BUCKET, path)).toBe(true);

    // Mismatched: declare the hash of `good` but stream different bytes.
    const badPath = `${ctx.defaultAppId}/upl_sha_bad/blob`;
    const badKey = `${UPLOAD_BUCKET}/${badPath}`;
    const bad = new Uint8Array([9, 9, 9, 9, 9]);
    await expect(
      writeProxyUploadContent(badKey, new Blob([bad]).stream(), bad.byteLength, 0, sha256Hex(good)),
    ).rejects.toMatchObject({ status: 400, code: "checksum_mismatch" });
    // Object removed before it could be consumed.
    expect(await storageExists(UPLOAD_BUCKET, badPath)).toBe(false);
  });

  it("consume rejects when the streamed hash disagrees with the row's declared sha256", async () => {
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const actor: Actor = { type: "user", id: ctx.user.id };
    // Row claims a sha256 that does NOT match the stored PDF bytes.
    await seedUpload(scope, {
      id: "upl_sha_consume",
      createdBy: ctx.user.id,
      sha256: sha256Hex(new Uint8Array([0, 0, 0])),
    });
    await expect(
      consumeUploadStream("upl_sha_consume", { ...scope, actor }, hashingSink),
    ).rejects.toMatchObject({ status: 400, code: "checksum_mismatch" });
    // First-consume rollback: the object was dropped so a re-PUT is possible.
    expect(await storageExists(UPLOAD_BUCKET, `${ctx.defaultAppId}/upl_sha_consume/file.pdf`)).toBe(
      false,
    );
  });

  it("consume passes when the declared sha256 matches the bytes", async () => {
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const actor: Actor = { type: "user", id: ctx.user.id };
    await seedUpload(scope, {
      id: "upl_sha_match",
      createdBy: ctx.user.id,
      sha256: sha256Hex(PDF_BYTES),
    });
    const meta = await consumeUploadStream("upl_sha_match", { ...scope, actor }, hashingSink);
    expect(meta.sha256).toBe(sha256Hex(PDF_BYTES));
    // Streamed bytes readable (retained for reuse).
    expect(
      await storageDownload(UPLOAD_BUCKET, `${ctx.defaultAppId}/upl_sha_match/file.pdf`),
    ).not.toBeNull();
  });
});

describe("createUpload staging budget", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "budget" });
  });

  it("rejects the (N+1)th active upload for an actor (429)", async () => {
    await withEnv({ UPLOAD_MAX_ACTIVE_PER_ACTOR: "2" }, async () => {
      const base = {
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        createdBy: ctx.user.id,
        mime: "application/pdf",
        size: 10,
      };
      await createUpload({ ...base, name: "a.pdf" });
      await createUpload({ ...base, name: "b.pdf" });
      await expect(createUpload({ ...base, name: "c.pdf" })).rejects.toMatchObject({
        status: 429,
        code: "upload_staging_limit_exceeded",
      });
    });
  });

  it("a consumed upload frees the per-actor budget", async () => {
    await withEnv({ UPLOAD_MAX_ACTIVE_PER_ACTOR: "1" }, async () => {
      const base = {
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        createdBy: ctx.user.id,
        mime: "application/pdf",
        size: 10,
      };
      const first = await createUpload({ ...base, name: "a.pdf" });
      // Mark it consumed → it leaves the active set.
      await db.update(uploads).set({ consumedAt: new Date() }).where(eq(uploads.id, first.id));
      // A new create now fits within the budget of 1.
      await expect(createUpload({ ...base, name: "b.pdf" })).resolves.toMatchObject({
        object: "upload",
      });
    });
  });

  it("rejects when the org active-bytes sum would be exceeded (403)", async () => {
    await withEnv(
      { UPLOAD_STAGING_MAX_BYTES_PER_ORG: "100", UPLOAD_MAX_ACTIVE_PER_ACTOR: "999" },
      async () => {
        const base = {
          orgId: ctx.orgId,
          applicationId: ctx.defaultAppId,
          createdBy: ctx.user.id,
          mime: "application/pdf",
        };
        await createUpload({ ...base, name: "a.pdf", size: 80 });
        await expect(createUpload({ ...base, name: "b.pdf", size: 40 })).rejects.toMatchObject({
          status: 403,
          code: "storage_limit_exceeded",
        });
      },
    );
  });
});
