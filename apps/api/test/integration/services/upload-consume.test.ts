// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `consumeUpload` — exercise the atomic claim that
 * prevents two concurrent runs from consuming the same upload:// URI, plus
 * cross-tenant isolation and the expired/missing-binary paths.
 *
 * Uses a real Postgres + filesystem storage; no routes exercised.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { uploads } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";
import { consumeUpload } from "../../../src/services/uploads.ts";
import { uploadFile as storagePut } from "@appstrate/db/storage";
import { ApiError } from "../../../src/lib/errors.ts";

const UPLOAD_BUCKET = "uploads";
const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // %PDF-1.4\n

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

describe("consumeUpload", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("concurrent consume of the same upload: exactly one wins", async () => {
    const ctx = await createTestContext({ orgSlug: "org-race" });
    const id = "upl_race_1";
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes: PDF_BYTES },
    );

    const settled = await Promise.allSettled([
      consumeUpload(id, { orgId: ctx.orgId, applicationId: ctx.defaultAppId }),
      consumeUpload(id, { orgId: ctx.orgId, applicationId: ctx.defaultAppId }),
    ]);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
  });

  it("a second sequential consume fails with 409 conflict", async () => {
    const ctx = await createTestContext({ orgSlug: "org-seq" });
    const id = "upl_seq_1";
    await seedUpload(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      { id, bytes: PDF_BYTES },
    );
    await consumeUpload(id, { orgId: ctx.orgId, applicationId: ctx.defaultAppId });
    try {
      await consumeUpload(id, { orgId: ctx.orgId, applicationId: ctx.defaultAppId });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(409);
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
      await consumeUpload(id, { orgId: other.orgId, applicationId: other.defaultAppId });
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
      await consumeUpload(id, { orgId: ctx.orgId, applicationId: ctx.defaultAppId });
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
      await consumeUpload(id, { orgId: ctx.orgId, applicationId: ctx.defaultAppId });
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
      await consumeUpload(id, { orgId: ctx.orgId, applicationId: ctx.defaultAppId });
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
    const consumed = await consumeUpload(id, {
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
    });
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
      await consumeUpload(id, { orgId: ctx.orgId, applicationId: ctx.defaultAppId });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(400);
      expect((e as ApiError).message.toLowerCase()).toContain("mime");
    }
  });
});
