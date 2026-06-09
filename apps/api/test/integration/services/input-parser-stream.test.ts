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
import { uploads, runs } from "@appstrate/db/schema";
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

/** Minimal Hono context stub — parseRequestInput reads the JSON body, orgId/applicationId, and (for rerun_from) endUser. */
function fakeCtx(
  body: unknown,
  ctx: { orgId: string; applicationId: string; endUser?: { id: string } },
): Context {
  return {
    req: { json: async () => body },
    get: (key: string) =>
      key === "orgId"
        ? ctx.orgId
        : key === "applicationId"
          ? ctx.applicationId
          : key === "endUser"
            ? ctx.endUser
            : undefined,
  } as unknown as Context;
}

/** Insert a minimal prior-run row the rerun_from path can resolve. */
async function seedRun(
  scope: { orgId: string; applicationId: string },
  opts: { id: string; input: Record<string, unknown> | null },
): Promise<void> {
  await db.insert(runs).values({
    id: opts.id,
    orgId: scope.orgId,
    applicationId: scope.applicationId,
    packageId: null,
    status: "cancelled",
    input: opts.input,
  });
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

    // Source upload stamped consumed; its storage object is RETAINED so the
    // same URI stays re-consumable for the post-consume reuse window (#634).
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    expect(row?.consumedAt).not.toBeNull();
    expect(await storageExists(UPLOAD_BUCKET, storagePath)).toBe(true);
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

describe("parseRequestInput — rerun_from (#634)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("replays a cancelled run's input — documents re-consumed, no re-upload", async () => {
    const ctx = await createTestContext({ orgSlug: "org-rerun-ok" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const id = "upl_rerun_ok_1";
    await seedUpload(scope, { id, bytes: PDF_BYTES });

    // First trigger consumes the upload into run 1's workspace…
    const priorRunId = `run_${crypto.randomUUID()}`;
    const input = { doc: `upload://${id}` };
    await parseRequestInput(fakeCtx({ input }, scope), priorRunId, fileSchema);
    // …and the run row persists the raw input (URI included). The run is then
    // cancelled — the upload stays re-consumable for the reuse window.
    await seedRun(scope, { id: priorRunId, input });

    const newRunId = `run_${crypto.randomUUID()}`;
    const result = await parseRequestInput(
      fakeCtx({ rerun_from: priorRunId }, scope),
      newRunId,
      fileSchema,
    );

    expect(result.input).toEqual(input);
    expect(result.uploadedFiles).toHaveLength(1);
    expect(result.uploadedFiles![0]).toMatchObject({
      fieldName: "doc",
      name: "file.pdf",
      size: PDF_BYTES.length,
    });
    // The replayed document landed in the NEW run's workspace.
    const docStream = await downloadRunDocumentStream(newRunId, "file.pdf");
    expect(docStream).not.toBeNull();
    expect(new Uint8Array(await new Response(docStream!).arrayBuffer())).toEqual(
      new Uint8Array(PDF_BYTES),
    );
  });

  it("rejects when both input and rerun_from are sent", async () => {
    const ctx = await createTestContext({ orgSlug: "org-rerun-both" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    await expect(
      parseRequestInput(
        fakeCtx({ input: {}, rerun_from: "run_x" }, scope),
        `run_${crypto.randomUUID()}`,
        fileSchema,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a non-string rerun_from", async () => {
    const ctx = await createTestContext({ orgSlug: "org-rerun-shape" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    await expect(
      parseRequestInput(
        fakeCtx({ rerun_from: 42 }, scope),
        `run_${crypto.randomUUID()}`,
        fileSchema,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("hides another tenant's run behind not-found (RBAC)", async () => {
    const owner = await createTestContext({ orgSlug: "org-rerun-owner" });
    const other = await createTestContext({ orgSlug: "org-rerun-other" });
    const priorRunId = `run_${crypto.randomUUID()}`;
    await seedRun(
      { orgId: owner.orgId, applicationId: owner.defaultAppId },
      { id: priorRunId, input: { doc: "upload://upl_whatever1" } },
    );

    await expect(
      parseRequestInput(
        fakeCtx(
          { rerun_from: priorRunId },
          { orgId: other.orgId, applicationId: other.defaultAppId },
        ),
        `run_${crypto.randomUUID()}`,
        fileSchema,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects replaying a different agent's run with 409 rerun_agent_mismatch", async () => {
    const ctx = await createTestContext({ orgSlug: "org-rerun-agent" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const priorRunId = `run_${crypto.randomUUID()}`;
    // seedRun stamps packageId NULL — any concrete agent id mismatches.
    await seedRun(scope, { id: priorRunId, input: {} });

    await expect(
      parseRequestInput(
        fakeCtx({ rerun_from: priorRunId }, scope),
        `run_${crypto.randomUUID()}`,
        fileSchema,
        {
          agentPackageId: "@acme/agent",
        },
      ),
    ).rejects.toMatchObject({ status: 409, code: "rerun_agent_mismatch" });
  });

  it("end-users cannot replay runs that are not their own", async () => {
    const ctx = await createTestContext({ orgSlug: "org-rerun-eu" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const priorRunId = `run_${crypto.randomUUID()}`;
    // Prior run has no end-user → an end-user caller must not see it.
    await seedRun(scope, { id: priorRunId, input: {} });

    await expect(
      parseRequestInput(
        fakeCtx({ rerun_from: priorRunId }, { ...scope, endUser: { id: "eu_someone" } }),
        `run_${crypto.randomUUID()}`,
        fileSchema,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("reports 410 when the replayed upload's reuse window has elapsed", async () => {
    const ctx = await createTestContext({ orgSlug: "org-rerun-gone" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const id = "upl_rerun_gone_1";
    await seedUpload(scope, { id, bytes: PDF_BYTES });
    const input = { doc: `upload://${id}` };
    const priorRunId = `run_${crypto.randomUUID()}`;
    await parseRequestInput(fakeCtx({ input }, scope), priorRunId, fileSchema);
    await seedRun(scope, { id: priorRunId, input });
    // Push the first consume outside the 24h reuse window.
    await db
      .update(uploads)
      .set({ consumedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(uploads.id, id));

    await expect(
      parseRequestInput(
        fakeCtx({ rerun_from: priorRunId }, scope),
        `run_${crypto.randomUUID()}`,
        fileSchema,
      ),
    ).rejects.toMatchObject({ status: 410 });
  });

  it("replays a run with null input as an empty input", async () => {
    const ctx = await createTestContext({ orgSlug: "org-rerun-null" });
    const scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const priorRunId = `run_${crypto.randomUUID()}`;
    await seedRun(scope, { id: priorRunId, input: null });

    const result = await parseRequestInput(
      fakeCtx({ rerun_from: priorRunId }, scope),
      `run_${crypto.randomUUID()}`,
      // No file fields required — empty input passes an empty schema.
      { type: "object", properties: {} },
    );
    expect(result.input).toEqual({});
    expect(result.uploadedFiles).toBeUndefined();
  });
});
