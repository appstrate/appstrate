// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `parseRequestInput`'s streamed document consume — the
 * glue that pipes each staged upload straight from the uploads bucket into the
 * run workspace (no full buffer in API memory), writes the documents manifest,
 * and rolls the workspace back when a document fails validation.
 *
 * Drives `parseRequestInput` directly with a minimal fake Hono context so the
 * run-trigger pipeline (Docker, LLM) is not involved. Real Postgres + FS
 * storage.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { Context } from "hono";
import { db } from "@appstrate/db/client";
import { uploads } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";
import { parseRequestInput } from "../../../src/services/input-parser.ts";
import {
  downloadRunDocumentStream,
  downloadRunDocumentsManifest,
} from "../../../src/services/run-workspace-storage.ts";
import { uploadFile as storagePut, fileExists as storageExists } from "@appstrate/db/storage";
import { ApiError } from "../../../src/lib/errors.ts";
import type { JSONSchemaObject } from "@appstrate/core/form";

const UPLOAD_BUCKET = "uploads";
const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // %PDF-1.4\n

const fileSchema: JSONSchemaObject = {
  type: "object",
  properties: {
    doc: { type: "string", format: "uri", contentMediaType: "application/pdf" },
  },
};

async function seedUpload(
  ctx: { orgId: string; applicationId: string },
  opts: { id: string; bytes: Buffer; mime?: string; sizeOverride?: number },
): Promise<void> {
  const storagePath = `${ctx.applicationId}/${opts.id}/file.pdf`;
  await storagePut(UPLOAD_BUCKET, storagePath, opts.bytes);
  await db.insert(uploads).values({
    id: opts.id,
    orgId: ctx.orgId,
    applicationId: ctx.applicationId,
    createdBy: null,
    storageKey: `${UPLOAD_BUCKET}/${storagePath}`,
    name: "file.pdf",
    mime: opts.mime ?? "application/pdf",
    size: opts.sizeOverride ?? opts.bytes.length,
    expiresAt: new Date(Date.now() + 900 * 1000),
  });
}

/** Minimal Hono context stub — parseRequestInput only reads the JSON body and orgId/applicationId. */
function fakeCtx(body: unknown, ctx: { orgId: string; applicationId: string }): Context {
  return {
    req: { json: async () => body },
    get: (key: string) =>
      key === "orgId" ? ctx.orgId : key === "applicationId" ? ctx.applicationId : undefined,
  } as unknown as Context;
}

describe("parseRequestInput — streamed document consume", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("streams the upload into the run workspace + writes the manifest", async () => {
    const ctx = await createTestContext({ orgSlug: "org-stream-ok" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const id = "upl_stream_ok_1";
    const storagePath = `${ctx.defaultAppId}/${id}/file.pdf`;
    await seedUpload(scope, { id, bytes: PDF_BYTES });

    const runId = `run_${crypto.randomUUID()}`;
    const result = await parseRequestInput(
      fakeCtx({ input: { doc: `upload://${id}` } }, scope),
      runId,
      fileSchema,
    );

    // Metadata surfaced, no buffer.
    expect(result.uploadedFiles).toHaveLength(1);
    const file = result.uploadedFiles![0]!;
    expect(file).toMatchObject({
      fieldName: "doc",
      name: "file.pdf",
      type: "application/pdf",
      size: PDF_BYTES.length,
    });
    expect("buffer" in file).toBe(false);

    // Document landed in the run workspace + manifest enumerates it.
    const docStream = await downloadRunDocumentStream(runId, "file.pdf");
    expect(docStream).not.toBeNull();
    expect(new Uint8Array(await new Response(docStream!).arrayBuffer())).toEqual(
      new Uint8Array(PDF_BYTES),
    );
    const manifest = await downloadRunDocumentsManifest(runId);
    expect(manifest?.documents).toEqual([{ name: "file.pdf", size: PDF_BYTES.length }]);

    // Source upload consumed + its storage object dropped.
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    expect(row?.consumedAt).not.toBeNull();
    expect(await storageExists(UPLOAD_BUCKET, storagePath)).toBe(false);
  });

  it("rolls the workspace back + releases the claim on a size mismatch", async () => {
    const ctx = await createTestContext({ orgSlug: "org-stream-size" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const id = "upl_stream_size_1";
    // Declared size larger than the bytes actually staged → mismatch at drain.
    await seedUpload(scope, { id, bytes: PDF_BYTES, sizeOverride: PDF_BYTES.length + 1 });

    const runId = `run_${crypto.randomUUID()}`;
    await expect(
      parseRequestInput(fakeCtx({ input: { doc: `upload://${id}` } }, scope), runId, fileSchema),
    ).rejects.toMatchObject({ status: 400 });

    // Workspace rolled back — no orphaned document or manifest.
    expect(await downloadRunDocumentStream(runId, "file.pdf")).toBeNull();
    expect(await downloadRunDocumentsManifest(runId)).toBeNull();
    // Claim released so the client can re-upload + retry.
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    expect(row?.consumedAt).toBeNull();
  });

  it("aborts mid-stream when an upload overshoots its declared size", async () => {
    const ctx = await createTestContext({ orgSlug: "org-stream-overshoot" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const id = "upl_stream_overshoot_1";
    // Declares 5 bytes but stages ~64 KB — the declared-small / uploaded-huge
    // abuse the early-abort guard exists for. The counter must error the stream
    // before the whole object lands in the run workspace.
    const huge = Buffer.concat([PDF_BYTES, Buffer.alloc(64 * 1024, 0x20)]);
    await seedUpload(scope, { id, bytes: huge, sizeOverride: 5 });

    const runId = `run_${crypto.randomUUID()}`;
    await expect(
      parseRequestInput(fakeCtx({ input: { doc: `upload://${id}` } }, scope), runId, fileSchema),
    ).rejects.toMatchObject({ status: 400 });

    // Workspace rolled back, claim released — same guarantees as any rejection.
    expect(await downloadRunDocumentStream(runId, "file.pdf")).toBeNull();
    expect(await downloadRunDocumentsManifest(runId)).toBeNull();
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    expect(row?.consumedAt).toBeNull();
  });

  it("rolls the workspace back on a MIME mismatch", async () => {
    const ctx = await createTestContext({ orgSlug: "org-stream-mime" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const id = "upl_stream_mime_1";
    // Declared application/pdf, but the bytes are plain text → magic-byte sniff fails.
    await seedUpload(scope, {
      id,
      bytes: Buffer.from("not a pdf", "utf-8"),
      mime: "application/pdf",
    });

    const runId = `run_${crypto.randomUUID()}`;
    let thrown: unknown;
    try {
      await parseRequestInput(
        fakeCtx({ input: { doc: `upload://${id}` } }, scope),
        runId,
        fileSchema,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(400);
    expect(await downloadRunDocumentStream(runId, "file.pdf")).toBeNull();
    expect(await downloadRunDocumentsManifest(runId)).toBeNull();
  });
});
